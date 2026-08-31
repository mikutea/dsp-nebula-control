import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { verifyBackupPair } from './backups.js'
import {
  SaveRestoreMutationScopeLostError,
  SaveTransactionService,
  previewBackupRetention,
  type RuntimeStoppedEvidence,
  type SaveTransactionHookPhase
} from './transactions.js'

const temporaryRoots: string[] = []
const stoppedEvidence: RuntimeStoppedEvidence = {
  protocol: 'DYSON_CONTROL_RUNTIME_V1',
  expected: 'stopped',
  state: 'matched',
  processVerified: true,
  gamePortListening: false
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('save pair backup transactions', () => {
  it('dry-runs without publishing and emits a redacted durable audit record', async () => {
    const fixture = await seedPair('Dry_Run', Buffer.from('fictional-dsv'), Buffer.from('fictional-server'))
    const requestId = randomUUID()
    const service = makeService(fixture)

    const result = await service.backup({ requestId, saveName: fixture.saveName, dryRun: true })

    expect(result).toMatchObject({
      operation: 'backup',
      status: 'dry-run',
      dryRun: true,
      backupId: `tx-${requestId}`,
      reused: false,
      pairBytes: 29,
      auditStored: true
    })
    await expect(stat(path.join(fixture.backupRoot, `tx-${requestId}`))).rejects.toMatchObject({ code: 'ENOENT' })
    const audit = await readAuditText(fixture.saveRoot)
    expect(audit).toContain('"action":"save.backup"')
    expect(audit).not.toContain(fixture.root)
    expect(audit).not.toContain(fixture.saveRoot)
    expect(audit).not.toMatch(/sha256|revision|password|secret/i)
  })

  it('streams a large pair into a verified manifest and reuses the same request idempotently', async () => {
    const dsv = Buffer.alloc(2 * 1024 * 1024 + 17, 0x41)
    const server = Buffer.alloc(1024 * 1024 + 31, 0x42)
    const fixture = await seedPair('Late_Game', dsv, server)
    const requestId = randomUUID()
    const service = makeService(fixture)

    const first = await service.backup({ requestId, saveName: fixture.saveName })
    expect(first).toMatchObject({ status: 'succeeded', reused: false, pairBytes: dsv.length + server.length })
    expect(await verifyBackupPair({ backupRoot: fixture.backupRoot, backupId: first.backupId }))
      .toMatchObject({ health: 'healthy', pairPresent: true, totalBytes: dsv.length + server.length })
    expect((await readdir(fixture.backupRoot)).sort()).toEqual([first.backupId])

    await writeFile(path.join(fixture.saveRoot, `${fixture.saveName}.dsv`), 'newer-live-save', 'utf8')
    await writeFile(path.join(fixture.saveRoot, `${fixture.saveName}.server`), 'newer-live-sidecar', 'utf8')
    const reused = await service.backup({ requestId, saveName: fixture.saveName })
    expect(reused).toMatchObject({ status: 'succeeded', reused: true, backupId: first.backupId })
    expect(await readFile(path.join(fixture.backupRoot, first.backupId, `${fixture.saveName}.dsv`)))
      .toEqual(dsv)
  })

  it('rejects an incomplete pair and never publishes a one-sided backup', async () => {
    const fixture = await seedPair('Incomplete', Buffer.from('dsv'), Buffer.from('server'))
    await rm(path.join(fixture.saveRoot, `${fixture.saveName}.server`))
    const requestId = randomUUID()

    const result = await makeService(fixture).backup({ requestId, saveName: fixture.saveName })

    expect(result).toMatchObject({ status: 'rejected', errorCode: 'SAVE_PAIR_INCOMPLETE' })
    await expect(stat(path.join(fixture.backupRoot, `tx-${requestId}`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails the stability window when the live pair keeps changing', async () => {
    const fixture = await seedPair('Changing', Buffer.from('dsv-0'), Buffer.from('server-0'))
    let generation = 0
    const service = makeService(fixture, {
      snapshotAttempts: 1,
      wait: async () => {
        generation += 1
        await writeFile(
          path.join(fixture.saveRoot, `${fixture.saveName}.dsv`),
          `dsv-${generation}`,
          'utf8'
        )
      }
    })
    const requestId = randomUUID()

    const result = await service.backup({ requestId, saveName: fixture.saveName })

    expect(result).toMatchObject({ status: 'failed', errorCode: 'SAVE_PAIR_CHANGED' })
    await expect(stat(path.join(fixture.backupRoot, `tx-${requestId}`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows only one backup or restore transaction across concurrent callers', async () => {
    const fixture = await seedPair('Concurrent', Buffer.from('dsv'), Buffer.from('server'))
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    const first = makeService(fixture, {
      hooks: async (phase) => {
        if (phase === 'before-backup-publish') {
          entered()
          await releasePromise
        }
      }
    })
    const contender = makeService(fixture)
    const firstPromise = first.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await enteredPromise

    const contenderResult = await contender.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    release()
    const firstResult = await firstPromise

    expect(contenderResult).toMatchObject({ status: 'busy', errorCode: 'SAVE_TRANSACTION_BUSY' })
    expect(firstResult.status).toBe('succeeded')
  })

  it('recovers only an allowlisted stale stage for an interrupted idempotent request', async () => {
    const fixture = await seedPair('Stale_Stage', Buffer.from('dsv'), Buffer.from('server'))
    const requestId = randomUUID()
    const stage = path.join(fixture.backupRoot, `.staging-${requestId}`)
    await mkdir(stage)
    await writeFile(path.join(stage, `${fixture.saveName}.dsv`), 'partial', 'utf8')

    const result = await makeService(fixture).backup({ requestId, saveName: fixture.saveName })

    expect(result).toMatchObject({ status: 'succeeded', reused: false })
    await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await verifyBackupPair({ backupRoot: fixture.backupRoot, backupId: result.backupId }))
      .toMatchObject({ health: 'healthy' })
  })

  it('rejects traversal names and redirected roots before touching save data', async () => {
    const fixture = await seedPair('Boundary', Buffer.from('dsv'), Buffer.from('server'))
    await expect(makeService(fixture).backup({
      requestId: randomUUID(),
      saveName: '../escape'
    })).rejects.toMatchObject({ code: 'SAVE_REQUEST_INVALID' })

    const redirected = path.join(fixture.root, 'redirected-save-root')
    try {
      await symlink(fixture.saveRoot, redirected, 'junction')
    } catch (error) {
      if (hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) return
      throw error
    }
    const redirectedService = new SaveTransactionService({
      saveRoot: redirected,
      backupRoot: fixture.backupRoot,
      verifyServiceStopped: async () => stoppedEvidence,
      stableWindowMs: 0
    })
    const result = await redirectedService.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    expect(result).toMatchObject({ status: 'failed', errorCode: 'SAVE_ROOT_UNAVAILABLE', auditStored: false })
  })
})

describe('save pair restore transactions', () => {
  it('threads the lease signal through both stopped proofs and checks scope around every live rename', async () => {
    const fixture = await seedPair(
      'Restore_Lease_Scope',
      Buffer.from('scope-source-dsv'),
      Buffer.from('scope-source-server')
    )
    const setup = makeService(fixture)
    const source = await setup.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('scope-live-dsv'), Buffer.from('scope-live-server'))
    const before = await setup.inspect(fixture.saveName)
    const controller = new AbortController()
    const observedSignals: Array<AbortSignal | undefined> = []
    let activeChecks = 0
    const service = makeService(fixture, {
      gate: async (signal) => {
        observedSignals.push(signal)
        return stoppedEvidence
      }
    })

    const result = await service.restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }, {
      signal: controller.signal,
      assertActive: () => { activeChecks += 1 }
    })

    expect(result.status).toBe('succeeded')
    expect(observedSignals).toEqual([controller.signal, controller.signal])
    expect(activeChecks).toBe(10)
  })

  it('propagates lease loss immediately after a live rename instead of classifying it as rollback failure', async () => {
    const fixture = await seedPair(
      'Restore_Lease_Lost',
      Buffer.from('lost-source-dsv'),
      Buffer.from('lost-source-server')
    )
    const setup = makeService(fixture)
    const source = await setup.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('lost-live-dsv'), Buffer.from('lost-live-server'))
    const before = await setup.inspect(fixture.saveName)
    let activeChecks = 0

    await expect(makeService(fixture).restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }, {
      signal: new AbortController().signal,
      assertActive: () => {
        activeChecks += 1
        if (activeChecks === 4) throw new Error('private lease detail')
      }
    })).rejects.toBeInstanceOf(SaveRestoreMutationScopeLostError)
    expect(activeChecks).toBe(4)
  })

  it('restores both bytes only after a stopped gate and protects the current pair first', async () => {
    const originalDsv = Buffer.from('backup-dsv-bytes')
    const originalServer = Buffer.from('backup-server-bytes')
    const currentDsv = Buffer.from('current-dsv-before-restore')
    const currentServer = Buffer.from('current-server-before-restore')
    const fixture = await seedPair('Restore_OK', originalDsv, originalServer)
    let gateCalls = 0
    const service = makeService(fixture, {
      gate: async () => {
        gateCalls += 1
        return stoppedEvidence
      }
    })
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, currentDsv, currentServer)
    const before = await service.inspect(fixture.saveName)
    const protectionRequestId = randomUUID()

    const result = await service.restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId
    })

    expect(result).toMatchObject({
      status: 'succeeded',
      rollback: 'not-required',
      protectionBackupId: `tx-${protectionRequestId}`,
      beforeRevision: before.revision,
      reused: false,
      auditStored: true
    })
    expect(gateCalls).toBe(2)
    expect(await readPair(fixture)).toEqual({ dsv: originalDsv, server: originalServer })
    expect(await readFile(path.join(
      fixture.backupRoot,
      `tx-${protectionRequestId}`,
      `${fixture.saveName}.dsv`
    ))).toEqual(currentDsv)
    expect(await readFile(path.join(
      fixture.backupRoot,
      `tx-${protectionRequestId}`,
      `${fixture.saveName}.server`
    ))).toEqual(currentServer)
  })

  it('refuses a running or unverifiable runtime without a protection point or target writes', async () => {
    const fixture = await seedPair('Gate', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const healthyService = makeService(fixture)
    const source = await healthyService.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('current-dsv'), Buffer.from('current-server'))
    const beforeBytes = await readPair(fixture)
    const before = await healthyService.inspect(fixture.saveName)
    const protectionRequestId = randomUUID()
    const runningService = makeService(fixture, {
      gate: async () => ({ ...stoppedEvidence, gamePortListening: true })
    })

    const result = await runningService.restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId
    })

    expect(result).toMatchObject({ status: 'rejected', errorCode: 'SAVE_SERVICE_NOT_STOPPED' })
    expect(await readPair(fixture)).toEqual(beforeBytes)
    await expect(stat(path.join(fixture.backupRoot, `tx-${protectionRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an optimistic revision conflict before creating protection data', async () => {
    const fixture = await seedPair('Revision', Buffer.from('backup-dsv'), Buffer.from('backup-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const protectionRequestId = randomUUID()
    const wrongRevision = `pair-v1:${'0'.repeat(64)}`

    const result = await service.restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: wrongRevision,
      protectionRequestId
    })

    expect(result).toMatchObject({
      status: 'revision-conflict',
      errorCode: 'SAVE_REVISION_CONFLICT',
      auditStored: true
    })
    expect(result.audit).not.toHaveProperty('beforeRevision')
    expect(result.audit).not.toHaveProperty('afterRevision')
    await expect(stat(path.join(fixture.backupRoot, `tx-${protectionRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects a tampered manifest pair and leaves the live bytes untouched', async () => {
    const fixture = await seedPair('Tamper', Buffer.from('backup-dsv'), Buffer.from('backup-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('live-dsv'), Buffer.from('live-server'))
    const before = await service.inspect(fixture.saveName)
    const beforeBytes = await readPair(fixture)
    await writeFile(
      path.join(fixture.backupRoot, source.backupId, `${fixture.saveName}.dsv`),
      'tampered!!',
      'utf8'
    )

    const result = await service.restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    })

    expect(result).toMatchObject({ status: 'rejected', errorCode: 'SAVE_BACKUP_CORRUPT' })
    expect(await readPair(fixture)).toEqual(beforeBytes)
  })

  it('rejects a schema-valid but cryptographically tampered manifest', async () => {
    const fixture = await seedPair('Manifest_Tamper', Buffer.from('backup-dsv'), Buffer.from('backup-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('live-dsv'), Buffer.from('live-server'))
    const before = await service.inspect(fixture.saveName)
    const manifestPath = path.join(fixture.backupRoot, source.backupId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ sha256: string }>
    }
    manifest.files[0]!.sha256 = '0'.repeat(64)
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

    const result = await service.restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    })

    expect(result).toMatchObject({ status: 'rejected', errorCode: 'SAVE_BACKUP_CORRUPT' })
    expect(await readPair(fixture)).toEqual({
      dsv: Buffer.from('live-dsv'),
      server: Buffer.from('live-server')
    })
  })

  it('automatically rolls both files back byte-for-byte after a partial restore failure', async () => {
    const fixture = await seedPair('Rollback', Buffer.from('backup-dsv'), Buffer.from('backup-server'))
    const sourceService = makeService(fixture)
    const source = await sourceService.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const currentDsv = Buffer.from('private-current-dsv')
    const currentServer = Buffer.from('private-current-server')
    await writePair(fixture, currentDsv, currentServer)
    const before = await sourceService.inspect(fixture.saveName)
    const service = makeService(fixture, {
      hooks: (phase) => {
        if (phase === 'after-restored-dsv-installed') throw new Error('private injected fault')
      }
    })

    const result = await service.restore({
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    })

    expect(result).toMatchObject({
      status: 'rolled-back',
      rollback: 'succeeded',
      errorCode: 'SAVE_COMMIT_FAILED',
      beforeRevision: before.revision,
      afterRevision: before.revision,
      auditStored: true
    })
    expect(await readPair(fixture)).toEqual({ dsv: currentDsv, server: currentServer })
    const serialized = `${JSON.stringify(result)}\n${await readAuditText(fixture.saveRoot)}`
    expect(serialized).not.toContain(fixture.root)
    expect(serialized).not.toContain('private injected fault')
    expect(result.audit).not.toHaveProperty('beforeRevision')
    expect(result.audit).not.toHaveProperty('afterRevision')
  })

  for (const recoveryCrashPhase of [
    'after-recovery-stage-reset',
    'after-recovery-staged',
    'after-recovery-dsv-target-removed',
    'after-recovery-dsv-installed',
    'after-recovery-server-target-removed',
    'after-recovery-server-installed'
  ] as const) {
    it(`replays durable compensation after a crash at ${recoveryCrashPhase}`, async () => {
      const fixture = await seedPair(
        `Recovery_${recoveryCrashPhase.replaceAll('-', '_')}`,
        Buffer.from('source-dsv'),
        Buffer.from('source-server')
      )
      const sourceService = makeService(fixture)
      const source = await sourceService.backup({ requestId: randomUUID(), saveName: fixture.saveName })
      const protectedPair = { dsv: Buffer.from('protected-dsv'), server: Buffer.from('protected-server') }
      await writePair(fixture, protectedPair.dsv, protectedPair.server)
      const before = await sourceService.inspect(fixture.saveName)
      const request = {
        requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
        protectionRequestId: randomUUID()
      }
      let commitFaultInjected = false
      let recoveryFaultInjected = false
      const faulting = makeService(fixture, {
        hooks: (phase) => {
          if (phase === 'after-restored-dsv-installed' && !commitFaultInjected) {
            commitFaultInjected = true
            throw new Error('enter durable compensation')
          }
          if (phase === recoveryCrashPhase && !recoveryFaultInjected) {
            recoveryFaultInjected = true
            throw new Error('fictional process crash during durable compensation')
          }
        }
      })

      const interrupted = await faulting.restore(request)
      expect(interrupted).toMatchObject({
        status: 'rollback-failed', rollback: 'failed', errorCode: 'SAVE_ROLLBACK_FAILED'
      })
      expect(await readLatestTestRestoreJournal(fixture.saveRoot, request.requestId))
        .not.toMatchObject({ phase: 'recovery-required' })

      const recovered = await makeService(fixture).restore(request)

      expect(recovered).toMatchObject({
        status: 'rolled-back', rollback: 'succeeded', errorCode: 'SAVE_COMMIT_FAILED',
        cleanupPending: false, maintenanceRequired: false, auditStored: true
      })
      expect(await readPair(fixture)).toEqual(protectedPair)
      await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
      for (const artifact of [
        path.join(fixture.saveRoot, `.rollback-${request.requestId}-dsv.bin`),
        path.join(fixture.saveRoot, `.rollback-${request.requestId}-server.bin`),
        path.join(fixture.saveRoot, `.restore-stage-${request.requestId}`),
        path.join(fixture.saveRoot, `.gc-${request.requestId}-rollback-dsv.bin`),
        path.join(fixture.saveRoot, `.gc-${request.requestId}-rollback-server.bin`),
        path.join(fixture.saveRoot, `.gc-${request.requestId}-stage`)
      ]) await expect(stat(artifact)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  for (const recoveryCrashPhase of [
    'after-journal-recovery-dsv-install-intent-sync',
    'after-recovery-stage-reset',
    'after-recovery-staged',
    'before-recovery-dsv-target-remove',
    'after-recovery-dsv-target-removed',
    'before-recovery-dsv-install',
    'after-recovery-dsv-installed',
    'after-journal-recovery-dsv-installed-sync',
    'after-journal-recovery-server-install-intent-sync',
    'before-recovery-server-target-remove',
    'after-recovery-server-target-removed',
    'before-recovery-server-install',
    'after-recovery-server-installed',
    'after-journal-recovery-server-installed-sync'
  ] as const satisfies readonly SaveTransactionHookPhase[]) {
    it(`recovers a complete after pair across ${recoveryCrashPhase}`, async () => {
      const crash = await seedCompleteAfterRestoreCrash(
        `Mixed_${recoveryCrashPhase.replaceAll('-', '_')}`
      )
      let injections = 0

      const interrupted = await makeService(crash.fixture, {
        hooks: (phase) => {
          if (phase !== recoveryCrashPhase) return
          injections += 1
          throw new Error('fictional abrupt loss at a durable compensation boundary')
        }
      }).restore(crash.request)

      expect(injections).toBeGreaterThan(0)
      expect(interrupted).toMatchObject({
        status: 'rollback-failed', rollback: 'failed', errorCode: 'SAVE_ROLLBACK_FAILED'
      })
      if ([
        'after-recovery-dsv-installed',
        'after-journal-recovery-dsv-installed-sync',
        'after-journal-recovery-server-install-intent-sync',
        'before-recovery-server-target-remove'
      ].includes(recoveryCrashPhase)) {
        expect(await readPair(crash.fixture)).toEqual({
          dsv: crash.protectedPair.dsv,
          server: crash.restoredPair.server
        })
      }
      expect(await readLatestTestRestoreJournal(crash.fixture.saveRoot, crash.request.requestId))
        .not.toMatchObject({ phase: 'recovery-required' })

      const replay = await makeService(crash.fixture).restore(crash.request)

      expect(replay).toMatchObject({
        status: 'rolled-back', rollback: 'succeeded', cleanupPending: false,
        maintenanceRequired: false, auditStored: true
      })
      expect(await readPair(crash.fixture)).toEqual(crash.protectedPair)
      await expectRestoreJournalAbsent(crash.fixture.saveRoot, crash.request.requestId)
    })
  }

  it('dry-runs a restore and retention plan without changing any pair or deleting backups', async () => {
    const fixture = await seedPair('Preview', Buffer.from('backup-dsv'), Buffer.from('backup-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('current-dsv'), Buffer.from('current-server'))
    const before = await service.inspect(fixture.saveName)
    const beforeBytes = await readPair(fixture)
    const protectionRequestId = randomUUID()
    const requestId = randomUUID()

    const result = await service.restore({
      requestId,
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId,
      dryRun: true
    })
    const retention = previewBackupRetention({
      referenceTime: '2026-08-30T00:00:00.000Z',
      policy: {
        keepLastHealthy: 1,
        keepDailyDays: 0,
        keepWeeklyWeeks: 0,
        minimumHealthy: 1,
        allowUnhealthyDeletion: false
      },
      candidates: [
        {
          backupId: source.backupId,
          createdAt: '2026-08-29T00:00:00.000Z',
          health: 'healthy',
          protected: false
        }
      ]
    })

    expect(result).toMatchObject({ status: 'dry-run', dryRun: true })
    expect(await readPair(fixture)).toEqual(beforeBytes)
    await expect(stat(path.join(fixture.backupRoot, `tx-${protectionRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(retention.mode).toBe('dry-run')
    expect(await stat(path.join(fixture.backupRoot, source.backupId))).toBeDefined()
  })

  it('reuses a completed restore receipt without overwriting or creating another protection point', async () => {
    const fixture = await seedPair('Restore_Replay', Buffer.from('backup-dsv'), Buffer.from('backup-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('current-dsv'), Buffer.from('current-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }

    expect((await service.restore(request)).status).toBe('succeeded')
    const replay = await service.restore(request)

    expect(replay).toMatchObject({ status: 'succeeded', reused: true })
    expect((await readdir(fixture.backupRoot)).filter((name) => name === `tx-${request.protectionRequestId}`))
      .toHaveLength(1)
  })

  it('replays a no-journal receipt without any lease, audit, backup, live-pair, gate, or GC mutation', async () => {
    const fixture = await seedPair('Receipt_Read_Only', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('before-dsv'), Buffer.from('before-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const committed = await service.restore(request)
    expect(committed).toMatchObject({ status: 'succeeded', cleanupPending: false, auditStored: true })

    await Promise.all([
      rm(path.join(fixture.backupRoot, source.backupId), { recursive: true }),
      rm(path.join(fixture.backupRoot, `tx-${request.protectionRequestId}`), { recursive: true })
    ])
    const advanced = { dsv: Buffer.from('advanced-live-dsv'), server: Buffer.from('advanced-live-server') }
    await writePair(fixture, advanced.dsv, advanced.server)
    const foreignRollback = path.join(fixture.saveRoot, `.rollback-${request.requestId}-dsv.bin`)
    await writeFile(foreignRollback, 'foreign-fixed-path', 'utf8')
    const controlRoot = path.join(fixture.saveRoot, '.dyson-save-control')
    const auditRoot = path.join(controlRoot, 'audit')
    const receiptRoot = path.join(controlRoot, 'receipts')
    const journalRoot = path.join(controlRoot, 'restore-journals')
    const unrelatedJournal = path.join(journalRoot, `restore-${randomUUID()}.json`)
    await writeFile(unrelatedJournal, 'foreign unresolved journal evidence', 'utf8')
    const snapshot = {
      controlMtime: (await stat(controlRoot)).mtimeMs,
      auditNames: (await readdir(auditRoot)).sort(),
      receiptNames: (await readdir(receiptRoot)).sort(),
      journalNames: (await readdir(journalRoot)).sort()
    }
    let gateCalls = 0
    const replayService = makeService(fixture, {
      gate: async () => {
        gateCalls += 1
        throw new Error('gate must not be called for immutable receipt replay')
      }
    })

    const replay = await replayService.restore(request)
    const dryRunConflict = await replayService.restore({ ...request, dryRun: true })

    expect(replay).toMatchObject({
      status: 'succeeded', reused: true, rollback: 'not-required',
      pairBytes: committed.pairBytes, beforeRevision: committed.beforeRevision,
      afterRevision: committed.afterRevision, cleanupPending: false, maintenanceRequired: false
    })
    expect(dryRunConflict).toMatchObject({
      status: 'rejected', errorCode: 'SAVE_IDEMPOTENCY_CONFLICT', auditStored: false
    })
    expect(gateCalls).toBe(0)
    expect(await readPair(fixture)).toEqual(advanced)
    expect(await readFile(foreignRollback, 'utf8')).toBe('foreign-fixed-path')
    expect(await readFile(unrelatedJournal, 'utf8')).toBe('foreign unresolved journal evidence')
    expect({
      controlMtime: (await stat(controlRoot)).mtimeMs,
      auditNames: (await readdir(auditRoot)).sort(),
      receiptNames: (await readdir(receiptRoot)).sort(),
      journalNames: (await readdir(journalRoot)).sort()
    }).toEqual(snapshot)
    await expect(stat(path.join(controlRoot, 'transaction.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a receipt whose embedded request id does not match its fixed filename', async () => {
    const fixture = await seedPair('Receipt_Request_Binding', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('before-dsv'), Buffer.from('before-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const committed = await service.restore(request)
    expect(committed.status).toBe('succeeded')
    const committedPair = await readPair(fixture)
    const receiptPath = path.join(
      fixture.saveRoot,
      '.dyson-save-control',
      'receipts',
      `restore-${request.requestId}.json`
    )
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    receipt.requestId = randomUUID()
    await writeFile(receiptPath, JSON.stringify(receipt), 'utf8')
    let gateCalls = 0

    await expect(makeService(fixture, {
      gate: async () => {
        gateCalls += 1
        return stoppedEvidence
      }
    }).restore(request)).rejects.toMatchObject({ code: 'SAVE_IDEMPOTENCY_CONFLICT' })
    expect(gateCalls).toBe(0)
    expect(await readPair(fixture)).toEqual(committedPair)
  })

  it('retains a committed journal when the first final audit write fails and repairs it on restart', async () => {
    const fixture = await seedPair('Receipt_Audit_Repair', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('before-dsv'), Buffer.from('before-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    let failedOnce = false
    const faulting = makeService(fixture, {
      hooks: (phase) => {
        if (phase === 'before-final-audit-store' && !failedOnce) {
          failedOnce = true
          throw new Error('fictional first final audit failure')
        }
      }
    })

    const first = await faulting.restore(request)
    expect(first).toMatchObject({ status: 'succeeded', auditStored: false, cleanupPending: false })
    expect(await readLatestTestRestoreJournal(fixture.saveRoot, request.requestId))
      .toMatchObject({ requestId: request.requestId, phase: 'gc-pending' })

    const replay = await makeService(fixture).restore(request)

    expect(replay).toMatchObject({
      status: 'succeeded', reused: true, auditStored: true,
      cleanupPending: false, maintenanceRequired: false
    })
    await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
    const audits = (await Promise.all((await readdir(path.join(
      fixture.saveRoot, '.dyson-save-control', 'audit'
    ))).map(async (name) => JSON.parse(await readFile(path.join(
      fixture.saveRoot, '.dyson-save-control', 'audit', name
    ), 'utf8')) as { requestId: string; status: string })))
    expect(audits.some((audit) => audit.requestId === request.requestId && audit.status === 'succeeded')).toBe(true)
  })

  for (const failingPhase of [
    'after-receipt',
    'after-first-rollback-cleanup',
    'before-stage-rmdir'
  ] as const) {
    it(`keeps the committed pair and retries GC after ${failingPhase}`, async () => {
      const restoredDsv = Buffer.from('committed-restored-dsv')
      const restoredServer = Buffer.from('committed-restored-server')
      const fixture = await seedPair(`Committed_Gc_${failingPhase}`, restoredDsv, restoredServer)
      const sourceService = makeService(fixture)
      const source = await sourceService.backup({ requestId: randomUUID(), saveName: fixture.saveName })
      await writePair(fixture, Buffer.from('pre-restore-dsv'), Buffer.from('pre-restore-server'))
      const before = await sourceService.inspect(fixture.saveName)
      const request = {
        requestId: randomUUID(),
        backupId: source.backupId,
        expectedRevision: before.revision,
        protectionRequestId: randomUUID()
      }
      let injected = false
      const faulting = makeService(fixture, {
        hooks: (phase) => {
          if (!injected && phase === failingPhase) {
            injected = true
            throw new Error('private committed cleanup fault')
          }
        }
      })

      const first = await faulting.restore(request)

      expect(first).toMatchObject({ status: 'succeeded', reused: false, rollback: 'not-required' })
      expect(await readPair(fixture)).toEqual({ dsv: restoredDsv, server: restoredServer })
      expect(await readLatestTestRestoreJournal(fixture.saveRoot, request.requestId)).toMatchObject({
        requestId: request.requestId,
        phase: 'gc-pending'
      })

      const replay = await makeService(fixture).restore(request)
      expect(replay).toMatchObject({ status: 'succeeded', reused: true, rollback: 'not-required' })
      expect(await readPair(fixture)).toEqual({ dsv: restoredDsv, server: restoredServer })
      await expect(stat(path.join(fixture.saveRoot, `.rollback-${request.requestId}-dsv.bin`)))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(path.join(fixture.saveRoot, `.rollback-${request.requestId}-server.bin`)))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(path.join(fixture.saveRoot, `.restore-stage-${request.requestId}`)))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
    })
  }

  it('keeps a journal+receipt restore committed but maintenance-pending when cleanup evidence is missing', async () => {
    const fixture = await seedPair('Committed_Missing_Evidence', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('before-dsv'), Buffer.from('before-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const first = await makeService(fixture, {
      hooks: (phase) => {
        if (phase === 'after-receipt') throw new Error('leave committed cleanup evidence')
      }
    }).restore(request)
    const rollbackDsv = path.join(fixture.saveRoot, `.rollback-${request.requestId}-dsv.bin`)
    const committedDsv = await readFile(path.join(fixture.saveRoot, `${fixture.saveName}.dsv`))
    expect(first).toMatchObject({
      status: 'succeeded', rollback: 'not-required', cleanupPending: true,
      maintenanceRequired: true, errorCode: 'SAVE_COMMIT_CLEANUP_PENDING'
    })
    await rm(path.join(fixture.backupRoot, `tx-${request.protectionRequestId}`), { recursive: true })
    await rm(path.join(fixture.saveRoot, `${fixture.saveName}.server`))

    const replay = await makeService(fixture).restore(request)

    expect(replay).toMatchObject({
      status: 'succeeded', reused: true, rollback: 'not-required',
      cleanupPending: true, maintenanceRequired: true,
      errorCode: 'SAVE_COMMIT_CLEANUP_PENDING', auditStored: true
    })
    expect(await readFile(path.join(fixture.saveRoot, `${fixture.saveName}.dsv`))).toEqual(committedDsv)
    await expect(stat(path.join(fixture.saveRoot, `${fixture.saveName}.server`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readLatestTestRestoreJournal(fixture.saveRoot, request.requestId))
      .toMatchObject({ requestId: request.requestId, phase: 'gc-pending' })
    await expect(stat(rollbackDsv)).resolves.toBeDefined()
  })

  it('keeps a journal+receipt restore committed and preserves an unowned fixed cleanup path', async () => {
    const fixture = await seedPair('Committed_Unknown_Owner', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('before-dsv'), Buffer.from('before-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    await makeService(fixture, {
      hooks: (phase) => {
        if (phase === 'after-receipt') throw new Error('leave committed cleanup evidence')
      }
    }).restore(request)
    const rollbackDsv = path.join(fixture.saveRoot, `.rollback-${request.requestId}-dsv.bin`)
    await writeFile(rollbackDsv, 'foreign replacement', 'utf8')
    const committedPair = await readPair(fixture)

    const replay = await makeService(fixture).restore(request)

    expect(replay).toMatchObject({
      status: 'succeeded', reused: true, rollback: 'not-required',
      cleanupPending: true, maintenanceRequired: true,
      errorCode: 'SAVE_COMMIT_CLEANUP_PENDING'
    })
    expect(await readPair(fixture)).toEqual(committedPair)
    expect(await readFile(rollbackDsv, 'utf8')).toBe('foreign replacement')
    expect(await readLatestTestRestoreJournal(fixture.saveRoot, request.requestId))
      .toMatchObject({ requestId: request.requestId, phase: 'gc-pending' })
  })

  it('keeps a durable receipt committed when its remaining journal candidate is unreadable', async () => {
    const fixture = await seedPair('Committed_Bad_Journal', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('before-dsv'), Buffer.from('before-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const committed = await makeService(fixture, {
      hooks: (phase) => {
        if (phase === 'after-receipt') throw new Error('retain committed cleanup evidence')
      }
    }).restore(request)
    expect(committed).toMatchObject({ status: 'succeeded', cleanupPending: true })
    const pairBefore = await readPair(fixture)
    const candidatePath = testRestoreJournalCandidatePath(fixture.saveRoot, request.requestId, 'a')
    await writeFile(candidatePath, '{"truncated":')
    const evidenceBefore = await snapshotRestoreJournalEvidence(fixture.saveRoot, request.requestId)

    const replay = await makeService(fixture).restore(request)

    expect(replay).toMatchObject({
      status: 'succeeded', reused: true, rollback: 'not-required',
      cleanupPending: true, maintenanceRequired: true,
      errorCode: 'SAVE_COMMIT_CLEANUP_PENDING', auditStored: true
    })
    expect(await readPair(fixture)).toEqual(pairBefore)
    expect(await snapshotRestoreJournalEvidence(fixture.saveRoot, request.requestId)).toEqual(evidenceBefore)
  })

  it('reconciles an after-original-dsv-moved crash from the durable protection pair', async () => {
    const sourceDsv = Buffer.from('fictional-source-dsv')
    const sourceServer = Buffer.from('fictional-source-server')
    const currentDsv = Buffer.from('fictional-current-dsv')
    const currentServer = Buffer.from('fictional-current-server')
    const fixture = await seedPair('Crash_Reconcile', sourceDsv, sourceServer)
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, currentDsv, currentServer)
    const before = await service.inspect(fixture.saveName)
    const requestId = randomUUID()
    const protectionRequestId = randomUUID()
    const protection = await service.backup({
      requestId: protectionRequestId,
      saveName: fixture.saveName
    })
    expect(source.afterRevision).toBeDefined()
    expect(protection.afterRevision).toBe(before.revision)
    if (source.afterRevision === undefined) throw new Error('fixture setup failed')

    const stage = path.join(fixture.saveRoot, `.restore-stage-${requestId}`)
    await mkdir(stage)
    await Promise.all([
      copyFile(
        path.join(fixture.backupRoot, source.backupId, `${fixture.saveName}.dsv`),
        path.join(stage, 'pair.dsv')
      ),
      copyFile(
        path.join(fixture.backupRoot, source.backupId, `${fixture.saveName}.server`),
        path.join(stage, 'pair.server')
      )
    ])
    await rename(
      path.join(fixture.saveRoot, `${fixture.saveName}.dsv`),
      path.join(fixture.saveRoot, `.rollback-${requestId}-dsv.bin`)
    )

    const controlRoot = path.join(fixture.saveRoot, '.dyson-save-control')
    const journalPayload = {
      requestId,
      backupId: source.backupId,
      protectionBackupId: `tx-${protectionRequestId}`,
      saveName: fixture.saveName,
      beforeRevision: before.revision,
      afterRevision: source.afterRevision,
      updatedAt: new Date().toISOString()
    }
    const preparedJournal = testRestoreJournalEnvelope({ ...journalPayload, phase: 'prepared' })
    const intentJournal = testRestoreJournalEnvelope(
      { ...journalPayload, phase: 'original-dsv-move-intent' },
      preparedJournal
    )
    const movedJournal = testRestoreJournalEnvelope(
      { ...journalPayload, phase: 'original-dsv-moved' },
      intentJournal
    )
    await Promise.all([
      writeFile(
        testRestoreJournalPath(fixture.saveRoot, requestId, intentJournal.slot),
        `${JSON.stringify(intentJournal)}\n`,
        'utf8'
      ),
      writeFile(
        testRestoreJournalPath(fixture.saveRoot, requestId, movedJournal.slot),
        `${JSON.stringify(movedJournal)}\n`,
        'utf8'
      )
    ])
    const result = await makeService(fixture).restore({
      requestId,
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId
    })

    expect(result).toMatchObject({
      status: 'rolled-back',
      rollback: 'succeeded',
      errorCode: 'SAVE_COMMIT_FAILED',
      beforeRevision: before.revision,
      afterRevision: before.revision,
      auditStored: true
    })
    expect(await readPair(fixture)).toEqual({ dsv: currentDsv, server: currentServer })
    for (const artifact of [
      stage,
      path.join(fixture.saveRoot, `.rollback-${requestId}-dsv.bin`),
      path.join(fixture.saveRoot, `.rollback-${requestId}-server.bin`)
    ]) {
      await expect(stat(artifact)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expectRestoreJournalAbsent(fixture.saveRoot, requestId)
  })

  it('publishes a valid next-slot candidate and deterministically reconciles it', async () => {
    const crash = await seedPreparedRestoreCrash('Candidate_With_Old_Slot')
    const candidate = testRestoreJournalEnvelope({
      requestId: crash.journal.requestId,
      backupId: crash.journal.backupId,
      protectionBackupId: crash.journal.protectionBackupId,
      saveName: crash.journal.saveName,
      beforeRevision: crash.journal.beforeRevision,
      afterRevision: crash.journal.afterRevision,
      phase: 'original-dsv-move-intent',
      updatedAt: new Date().toISOString()
    }, crash.journal)
    await writeFile(
      testRestoreJournalCandidatePath(crash.fixture.saveRoot, crash.request.requestId, candidate.slot),
      `${JSON.stringify(candidate)}\n`,
      'utf8'
    )
    const protectedPair = await readPair(crash.fixture)

    const result = await makeService(crash.fixture).restore(crash.request)

    expect(result).toMatchObject({
      status: 'rolled-back', rollback: 'succeeded', maintenanceRequired: false, auditStored: true
    })
    expect(await readPair(crash.fixture)).toEqual(protectedPair)
    await expectRestoreJournalAbsent(crash.fixture.saveRoot, crash.request.requestId)
  })

  it('publishes and reconciles an initial prepared candidate when no slot was published', async () => {
    const crash = await seedPreparedRestoreCrash('Candidate_Only_Prepared')
    await rm(crash.stage, { recursive: true })
    await rename(
      crash.journalPath,
      testRestoreJournalCandidatePath(crash.fixture.saveRoot, crash.request.requestId, crash.journal.slot)
    )
    const protectedPair = await readPair(crash.fixture)

    const result = await makeService(crash.fixture).restore(crash.request)

    expect(result).toMatchObject({
      status: 'rolled-back', rollback: 'succeeded', maintenanceRequired: false, auditStored: true
    })
    expect(await readPair(crash.fixture)).toEqual(protectedPair)
    await expectRestoreJournalAbsent(crash.fixture.saveRoot, crash.request.requestId)
  })

  it('rejects an initial prepared candidate when stage data already exists outside that publish boundary', async () => {
    const crash = await seedPreparedRestoreCrash('Candidate_Only_With_Stage')
    await rename(
      crash.journalPath,
      testRestoreJournalCandidatePath(crash.fixture.saveRoot, crash.request.requestId, crash.journal.slot)
    )
    const stageBefore = await readRestoreStage(crash.stage)
    const evidenceBefore = await snapshotRestoreJournalEvidence(
      crash.fixture.saveRoot,
      crash.request.requestId
    )

    const result = await makeService(crash.fixture).restore(crash.request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', maintenanceRequired: true,
      errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED', auditStored: false
    })
    expect(await readRestoreStage(crash.stage)).toEqual(stageBefore)
    expect(await snapshotRestoreJournalEvidence(crash.fixture.saveRoot, crash.request.requestId))
      .toEqual(evidenceBefore)
  })

  for (const unownedArtifact of [
    {
      name: 'same-content rollback file',
      create: async (crash: PreparedRestoreCrash, protectedPair: { dsv: Buffer; server: Buffer }) => {
        const artifact = path.join(
          crash.fixture.saveRoot,
          `.rollback-${crash.request.requestId}-dsv.bin`
        )
        await writeFile(artifact, protectedPair.dsv)
        return {
          assertPreserved: async () => {
            expect(await readFile(artifact)).toEqual(protectedPair.dsv)
          }
        }
      }
    },
    {
      name: 'empty GC stage directory',
      create: async (crash: PreparedRestoreCrash) => {
        const artifact = path.join(crash.fixture.saveRoot, `.gc-${crash.request.requestId}-stage`)
        await mkdir(artifact)
        return {
          assertPreserved: async () => {
            expect(await readdir(artifact)).toEqual([])
          }
        }
      }
    }
  ]) {
    it(`rejects an initial prepared candidate with an unowned ${unownedArtifact.name}`, async () => {
      const crash = await seedPreparedRestoreCrash(
        `Candidate_Only_${unownedArtifact.name.replaceAll(' ', '_')}`
      )
      await rm(crash.stage, { recursive: true })
      await rename(
        crash.journalPath,
        testRestoreJournalCandidatePath(crash.fixture.saveRoot, crash.request.requestId, crash.journal.slot)
      )
      const protectedPair = await readPair(crash.fixture)
      const artifact = await unownedArtifact.create(crash, protectedPair)
      const journalsBefore = await snapshotRestoreJournalEvidence(
        crash.fixture.saveRoot,
        crash.request.requestId
      )

      const result = await makeService(crash.fixture).restore(crash.request)

      expect(result).toMatchObject({
        status: 'failed', rollback: 'not-required', maintenanceRequired: true,
        errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED', auditStored: false
      })
      expect(await readPair(crash.fixture)).toEqual(protectedPair)
      await artifact.assertPreserved()
      expect(await snapshotRestoreJournalEvidence(crash.fixture.saveRoot, crash.request.requestId))
        .toEqual(journalsBefore)
    })
  }

  it('rejects a published prepared slot that predates an unowned GC quarantine', async () => {
    const crash = await seedPreparedRestoreCrash('Prepared_With_Unowned_GC_Stage')
    const gcStage = path.join(crash.fixture.saveRoot, `.gc-${crash.request.requestId}-stage`)
    await mkdir(gcStage)
    const protectedPair = await readPair(crash.fixture)
    const stageBefore = await readRestoreStage(crash.stage)
    const journalsBefore = await snapshotRestoreJournalEvidence(
      crash.fixture.saveRoot,
      crash.request.requestId
    )

    const result = await makeService(crash.fixture).restore(crash.request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', maintenanceRequired: true,
      errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED', auditStored: false
    })
    expect(await readPair(crash.fixture)).toEqual(protectedPair)
    expect(await readRestoreStage(crash.stage)).toEqual(stageBefore)
    expect(await readdir(gcStage)).toEqual([])
    expect(await snapshotRestoreJournalEvidence(crash.fixture.saveRoot, crash.request.requestId))
      .toEqual(journalsBefore)
  })

  it('does not publish or claim a foreign rollback file introduced after initial candidate sync', async () => {
    const fixture = await seedPair(
      'Candidate_Sync_Foreign_Rollback',
      Buffer.from('backup-dsv'),
      Buffer.from('backup-server')
    )
    const source = await makeService(fixture).backup({
      requestId: randomUUID(),
      saveName: fixture.saveName
    })
    const currentPair = {
      dsv: Buffer.from('current-dsv'),
      server: Buffer.from('current-server')
    }
    await writePair(fixture, currentPair.dsv, currentPair.server)
    const before = await makeService(fixture).inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const rollbackPath = path.join(
      fixture.saveRoot,
      `.rollback-${request.requestId}-dsv.bin`
    )
    let injected = false

    const result = await makeService(fixture, {
      hooks: async (phase) => {
        if (phase !== 'after-journal-prepared-sync' || injected) return
        injected = true
        await writeFile(rollbackPath, currentPair.dsv)
      }
    }).restore(request)

    expect(injected).toBe(true)
    expect(result).toMatchObject({
      status: 'failed',
      rollback: 'not-required',
      maintenanceRequired: true,
      errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED'
    })
    expect(await readPair(fixture)).toEqual(currentPair)
    expect(await readFile(rollbackPath)).toEqual(currentPair.dsv)
    await expect(stat(testRestoreJournalCandidatePath(fixture.saveRoot, request.requestId, 'a')))
      .resolves.toBeDefined()
    await expect(stat(testRestoreJournalPath(fixture.saveRoot, request.requestId, 'a')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  for (const partialScenario of [
    {
      name: 'truncated candidate',
      makeBytes: async (_crash: PreparedRestoreCrash) => Buffer.from('{"format":')
    },
    {
      name: 'foreign request candidate',
      makeBytes: async (crash: PreparedRestoreCrash) => Buffer.from(JSON.stringify(testRestoreJournalEnvelope({
        requestId: randomUUID(),
        backupId: crash.journal.backupId,
        protectionBackupId: crash.journal.protectionBackupId,
        saveName: crash.journal.saveName,
        beforeRevision: crash.journal.beforeRevision,
        afterRevision: crash.journal.afterRevision,
        phase: 'original-dsv-move-intent',
        updatedAt: new Date().toISOString()
      }, crash.journal)))
    },
    {
      name: 'broken digest chain candidate',
      makeBytes: async (crash: PreparedRestoreCrash) => {
        const next = testRestoreJournalEnvelope({
          requestId: crash.journal.requestId,
          backupId: crash.journal.backupId,
          protectionBackupId: crash.journal.protectionBackupId,
          saveName: crash.journal.saveName,
          beforeRevision: crash.journal.beforeRevision,
          afterRevision: crash.journal.afterRevision,
          phase: 'original-dsv-move-intent',
          updatedAt: new Date().toISOString()
        }, crash.journal)
        return Buffer.from(JSON.stringify(redigestTestRestoreJournal(next, { previousDigest: '0'.repeat(64) })))
      }
    },
    {
      name: 'illegal phase transition candidate',
      makeBytes: async (crash: PreparedRestoreCrash) => Buffer.from(JSON.stringify(testRestoreJournalEnvelope({
        requestId: crash.journal.requestId,
        backupId: crash.journal.backupId,
        protectionBackupId: crash.journal.protectionBackupId,
        saveName: crash.journal.saveName,
        beforeRevision: crash.journal.beforeRevision,
        afterRevision: crash.journal.afterRevision,
        phase: 'restored-server-installed',
        updatedAt: new Date().toISOString()
      }, crash.journal)))
    }
  ]) {
    it(`preserves ${partialScenario.name} as explicit maintenance evidence`, async () => {
      const crash = await seedPreparedRestoreCrash(`Bad_${partialScenario.name.replaceAll(' ', '_')}`)
      const candidatePath = testRestoreJournalCandidatePath(
        crash.fixture.saveRoot,
        crash.request.requestId,
        'b'
      )
      await writeFile(candidatePath, await partialScenario.makeBytes(crash))
      const journalsBefore = await snapshotRestoreJournalEvidence(
        crash.fixture.saveRoot,
        crash.request.requestId
      )
      const pairBefore = await readPair(crash.fixture)
      const stageBefore = await readRestoreStage(crash.stage)

      const result = await makeService(crash.fixture).restore(crash.request)

      expect(result).toMatchObject({
        status: 'failed', rollback: 'not-required', maintenanceRequired: true,
        errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED', auditStored: false
      })
      expect(await readPair(crash.fixture)).toEqual(pairBefore)
      expect(await readRestoreStage(crash.stage)).toEqual(stageBefore)
      expect(await snapshotRestoreJournalEvidence(crash.fixture.saveRoot, crash.request.requestId))
        .toEqual(journalsBefore)
    })
  }

  it('never adopts or deletes a pre-existing restore stage without a durable journal marker', async () => {
    const fixture = await seedPair('Unowned_Preexisting_Stage', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const protectedPair = { dsv: Buffer.from('protected-dsv'), server: Buffer.from('protected-server') }
    await writePair(fixture, protectedPair.dsv, protectedPair.server)
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const stage = path.join(fixture.saveRoot, `.restore-stage-${request.requestId}`)
    await mkdir(stage)
    const unowned = {
      dsv: Buffer.from('unowned-stage-dsv'),
      server: Buffer.from('unowned-stage-server')
    }
    await Promise.all([
      writeFile(path.join(stage, 'pair.dsv'), unowned.dsv),
      writeFile(path.join(stage, 'pair.server'), unowned.server)
    ])
    const auditRoot = path.join(fixture.saveRoot, '.dyson-save-control', 'audit')
    const auditsBefore = (await readdir(auditRoot)).sort()

    const result = await makeService(fixture).restore(request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', errorCode: 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE',
      auditStored: false
    })
    expect(await readPair(fixture)).toEqual(protectedPair)
    expect(await readRestoreStage(stage)).toEqual(unowned)
    expect((await readdir(auditRoot)).sort()).toEqual(auditsBefore)
    await expect(stat(path.join(fixture.backupRoot, `tx-${request.protectionRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
  })

  it('preserves a same-content pre-existing rollback file without creating restore ownership evidence', async () => {
    const fixture = await seedPair('Unowned_Preexisting_Rollback', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const protectedPair = { dsv: Buffer.from('protected-dsv'), server: Buffer.from('protected-server') }
    await writePair(fixture, protectedPair.dsv, protectedPair.server)
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const rollback = path.join(fixture.saveRoot, `.rollback-${request.requestId}-dsv.bin`)
    await writeFile(rollback, protectedPair.dsv)
    const auditRoot = path.join(fixture.saveRoot, '.dyson-save-control', 'audit')
    const auditsBefore = (await readdir(auditRoot)).sort()

    const result = await makeService(fixture).restore(request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', errorCode: 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE',
      auditStored: false
    })
    expect(await readPair(fixture)).toEqual(protectedPair)
    expect(await readFile(rollback)).toEqual(protectedPair.dsv)
    expect((await readdir(auditRoot)).sort()).toEqual(auditsBefore)
    await expect(stat(path.join(fixture.backupRoot, `tx-${request.protectionRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
  })

  it('preserves an empty pre-existing GC stage without creating restore ownership evidence', async () => {
    const fixture = await seedPair('Unowned_Preexisting_GC_Stage', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const protectedPair = { dsv: Buffer.from('protected-dsv'), server: Buffer.from('protected-server') }
    await writePair(fixture, protectedPair.dsv, protectedPair.server)
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const gcStage = path.join(fixture.saveRoot, `.gc-${request.requestId}-stage`)
    await mkdir(gcStage)
    const auditRoot = path.join(fixture.saveRoot, '.dyson-save-control', 'audit')
    const auditsBefore = (await readdir(auditRoot)).sort()

    const result = await makeService(fixture).restore(request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', errorCode: 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE',
      auditStored: false
    })
    expect(await readPair(fixture)).toEqual(protectedPair)
    expect(await readdir(gcStage)).toEqual([])
    expect((await readdir(auditRoot)).sort()).toEqual(auditsBefore)
    await expect(stat(path.join(fixture.backupRoot, `tx-${request.protectionRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
  })

  for (const journalPhase of [
    'prepared',
    'original-dsv-move-intent',
    'original-dsv-moved',
    'original-server-move-intent',
    'original-server-moved',
    'restored-dsv-install-intent',
    'restored-dsv-installed',
    'restored-server-install-intent',
    'restored-server-installed',
    'receipt-write-intent',
    'gc-pending'
  ] as const) {
    const crashHook = `after-journal-${journalPhase}-sync` as const
    it(`converges after the ${journalPhase} journal candidate is synced but not published`, async () => {
      const restoredPair = { dsv: Buffer.from('journal-source-dsv'), server: Buffer.from('journal-source-server') }
      const protectedPair = { dsv: Buffer.from('journal-before-dsv'), server: Buffer.from('journal-before-server') }
      const fixture = await seedPair(`Journal_${journalPhase.replaceAll('-', '_')}`, restoredPair.dsv, restoredPair.server)
      const service = makeService(fixture)
      const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
      await writePair(fixture, protectedPair.dsv, protectedPair.server)
      const before = await service.inspect(fixture.saveName)
      const request = {
        requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
        protectionRequestId: randomUUID()
      }
      let injections = 0

      await makeService(fixture, {
        hooks: (phase) => {
          if (phase !== crashHook) return
          injections += 1
          throw new Error('fictional loss after journal candidate sync')
        }
      }).restore(request)

      expect(injections).toBeGreaterThan(0)
      const replay = await makeService(fixture).restore(request)
      expect(['rolled-back', 'succeeded']).toContain(replay.status)
      expect(replay).toMatchObject({ maintenanceRequired: false, auditStored: true })
      expect(await readPair(fixture)).toEqual(
        replay.status === 'succeeded' ? restoredPair : protectedPair
      )
      await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
    })
  }

  for (const publishCrashWindow of [
    'before-journal-slot-replace',
    'after-journal-slot-replace',
    'after-journal-slot-published'
  ] as const) {
    it(`keeps a previous valid slot across ${publishCrashWindow}`, async () => {
      const fixture = await seedPair(
        `Slot_${publishCrashWindow.replaceAll('-', '_')}`,
        Buffer.from('slot-source-dsv'),
        Buffer.from('slot-source-server')
      )
      const service = makeService(fixture)
      const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
      const protectedPair = { dsv: Buffer.from('slot-before-dsv'), server: Buffer.from('slot-before-server') }
      await writePair(fixture, protectedPair.dsv, protectedPair.server)
      const before = await service.inspect(fixture.saveName)
      const request = {
        requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
        protectionRequestId: randomUUID()
      }
      let replacementStarted = false
      let injections = 0

      await makeService(fixture, {
        hooks: (phase) => {
          if (phase === 'before-journal-slot-replace') replacementStarted = true
          const selected = phase === publishCrashWindow &&
            (publishCrashWindow !== 'after-journal-slot-published' || replacementStarted)
          if (!selected) return
          injections += 1
          throw new Error('fictional loss during inactive-slot publication')
        }
      }).restore(request)

      expect(injections).toBeGreaterThan(0)
      const replay = await makeService(fixture).restore(request)
      expect(['rolled-back', 'succeeded']).toContain(replay.status)
      expect(replay).toMatchObject({ maintenanceRequired: false, auditStored: true })
      await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
    })
  }

  it('treats a verified initial slot publication as durable when the post-publish hook fails', async () => {
    const fixture = await seedPair(
      'Initial_Slot_Published',
      Buffer.from('initial-source-dsv'),
      Buffer.from('initial-source-server')
    )
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(fixture, Buffer.from('initial-before-dsv'), Buffer.from('initial-before-server'))
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    let injected = false

    const result = await makeService(fixture, {
      hooks: (phase) => {
        if (phase !== 'after-journal-slot-published' || injected) return
        injected = true
        throw new Error('fictional loss immediately after initial slot publication')
      }
    }).restore(request)

    expect(injected).toBe(true)
    expect(result).toMatchObject({ status: 'succeeded', maintenanceRequired: false, auditStored: true })
    await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
  })

  it('replays a rolled-back candidate whose sync completed before publication', async () => {
    const fixture = await seedPair('Journal_Rolled_Back', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const protectedPair = { dsv: Buffer.from('before-dsv'), server: Buffer.from('before-server') }
    await writePair(fixture, protectedPair.dsv, protectedPair.server)
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    let commitFault = false
    let journalFaults = 0

    const interrupted = await makeService(fixture, {
      hooks: (phase) => {
        if (phase === 'after-restored-dsv-installed' && !commitFault) {
          commitFault = true
          throw new Error('enter compensation')
        }
        if (phase === 'after-journal-rolled-back-sync') {
          journalFaults += 1
          throw new Error('fictional loss after rolled-back journal sync')
        }
      }
    }).restore(request)

    expect(commitFault).toBe(true)
    expect(journalFaults).toBeGreaterThan(0)
    expect(interrupted).toMatchObject({ status: 'rollback-failed', rollback: 'failed' })
    const replay = await makeService(fixture).restore(request)
    expect(replay).toMatchObject({
      status: 'rolled-back', rollback: 'succeeded', maintenanceRequired: false, auditStored: true
    })
    expect(await readPair(fixture)).toEqual(protectedPair)
    await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
  })

  it('preserves an unowned stage and the unpublished prepared candidate for maintenance', async () => {
    const fixture = await seedPair('Journal_Recovery_Required', Buffer.from('source-dsv'), Buffer.from('source-server'))
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const protectedPair = { dsv: Buffer.from('before-dsv'), server: Buffer.from('before-server') }
    await writePair(fixture, protectedPair.dsv, protectedPair.server)
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(), backupId: source.backupId, expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const stage = path.join(fixture.saveRoot, `.restore-stage-${request.requestId}`)
    let recoveryRequiredFaults = 0

    const interrupted = await makeService(fixture, {
      hooks: async (phase) => {
        if (phase === 'after-journal-prepared-sync') {
          await mkdir(stage)
          await writeFile(path.join(stage, 'foreign.extra'), 'unowned stage evidence', 'utf8')
        }
        if (phase === 'after-journal-recovery-required-sync') {
          recoveryRequiredFaults += 1
          throw new Error('fictional loss after recovery-required journal sync')
        }
      }
    }).restore(request)

    expect(recoveryRequiredFaults).toBe(0)
    expect(interrupted).toMatchObject({
      status: 'failed', rollback: 'not-required', maintenanceRequired: true,
      errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED'
    })
    expect(await readLatestTestRestoreJournal(fixture.saveRoot, request.requestId)).toMatchObject({
      phase: 'prepared', sequence: 1, previousDigest: null, slot: 'a'
    })
    await expect(stat(testRestoreJournalCandidatePath(fixture.saveRoot, request.requestId, 'a')))
      .resolves.toBeDefined()
    await expect(stat(testRestoreJournalPath(fixture.saveRoot, request.requestId, 'a')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(stage, 'foreign.extra'), 'utf8')).toBe('unowned stage evidence')

    const replay = await makeService(fixture).restore(request)
    expect(replay).toMatchObject({
      status: 'failed', rollback: 'not-required', maintenanceRequired: true,
      errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED', auditStored: false
    })
    expect(await readFile(path.join(stage, 'foreign.extra'), 'utf8')).toBe('unowned stage evidence')
  })

  it('fails closed on a prepared journal when a complete unknown pair appeared after the crash', async () => {
    const crash = await seedPreparedRestoreCrash('Prepared_Unknown')
    const unknown = {
      dsv: Buffer.from('fictional-admin-new-dsv'),
      server: Buffer.from('fictional-admin-new-server')
    }
    await writePair(crash.fixture, unknown.dsv, unknown.server)
    const stageBefore = await readRestoreStage(crash.stage)

    const result = await makeService(crash.fixture).restore(crash.request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED',
      maintenanceRequired: true, auditStored: false
    })
    expect(await readPair(crash.fixture)).toEqual(unknown)
    expect(await readRestoreStage(crash.stage)).toEqual(stageBefore)
    expect(await readLatestTestRestoreJournal(crash.fixture.saveRoot, crash.request.requestId))
      .toEqual(crash.journal)
  })

  for (const scenario of [
    {
      name: 'unknown staged file',
      mutate: async (crash: PreparedRestoreCrash) => {
        const candidate = path.join(crash.stage, 'pair.dsv')
        await writeFile(candidate, 'foreign staged bytes', 'utf8')
        return { candidate, expected: 'foreign staged bytes' }
      }
    },
    {
      name: 'unknown rollback file',
      mutate: async (crash: PreparedRestoreCrash) => {
        const candidate = path.join(crash.fixture.saveRoot, `.rollback-${crash.request.requestId}-dsv.bin`)
        await writeFile(candidate, 'foreign rollback bytes', 'utf8')
        return { candidate, expected: 'foreign rollback bytes' }
      }
    },
    {
      name: 'extra staged entry',
      mutate: async (crash: PreparedRestoreCrash) => {
        const candidate = path.join(crash.stage, 'foreign.extra')
        await writeFile(candidate, 'foreign extra bytes', 'utf8')
        return { candidate, expected: 'foreign extra bytes' }
      }
    }
  ]) {
    it(`fails closed when current is before but the prepared layout contains ${scenario.name}`, async () => {
      const crash = await seedPreparedRestoreCrash(`Before_${scenario.name.replaceAll(' ', '_')}`)
      const pairBefore = await readPair(crash.fixture)
      const foreign = await scenario.mutate(crash)

      const result = await makeService(crash.fixture).restore(crash.request)

      expect(result).toMatchObject({
        status: 'failed', rollback: 'not-required',
        errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED', maintenanceRequired: true, auditStored: false
      })
      expect(await readPair(crash.fixture)).toEqual(pairBefore)
      expect(await readFile(foreign.candidate, 'utf8')).toBe(foreign.expected)
      expect(await readLatestTestRestoreJournal(crash.fixture.saveRoot, crash.request.requestId))
        .toEqual(crash.journal)
    })
  }

  it('fails closed on a mid-commit journal when a complete unknown pair replaced the partial layout', async () => {
    const crash = await seedPreparedRestoreCrash('Mid_Unknown')
    const rollbackDsv = path.join(crash.fixture.saveRoot, `.rollback-${crash.request.requestId}-dsv.bin`)
    await rename(path.join(crash.fixture.saveRoot, `${crash.fixture.saveName}.dsv`), rollbackDsv)
    const intentJournal = testRestoreJournalEnvelope({
      requestId: crash.journal.requestId,
      backupId: crash.journal.backupId,
      protectionBackupId: crash.journal.protectionBackupId,
      saveName: crash.journal.saveName,
      beforeRevision: crash.journal.beforeRevision,
      afterRevision: crash.journal.afterRevision,
      phase: 'original-dsv-move-intent',
      updatedAt: new Date().toISOString()
    }, crash.journal)
    await writeFile(
      testRestoreJournalPath(crash.fixture.saveRoot, crash.request.requestId, intentJournal.slot),
      `${JSON.stringify(intentJournal)}\n`,
      'utf8'
    )
    const rollbackBefore = await readFile(rollbackDsv)
    const stageBefore = await readRestoreStage(crash.stage)
    const unknown = {
      dsv: Buffer.from('fictional-recovered-elsewhere-dsv'),
      server: Buffer.from('fictional-recovered-elsewhere-server')
    }
    await writePair(crash.fixture, unknown.dsv, unknown.server)

    const result = await makeService(crash.fixture).restore(crash.request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED',
      maintenanceRequired: true, auditStored: false
    })
    expect(await readPair(crash.fixture)).toEqual(unknown)
    expect(await readFile(rollbackDsv)).toEqual(rollbackBefore)
    expect(await readRestoreStage(crash.stage)).toEqual(stageBefore)
    expect(await readLatestTestRestoreJournal(crash.fixture.saveRoot, crash.request.requestId))
      .toEqual(intentJournal)
  })

  it('marks reconciliation recovery-required when its durable protection evidence is missing', async () => {
    const crash = await seedPreparedRestoreCrash('Missing_Protection')
    const pairBefore = await readPair(crash.fixture)
    const stageBefore = await readRestoreStage(crash.stage)
    await rm(
      path.join(crash.fixture.backupRoot, `tx-${crash.request.protectionRequestId}`),
      { recursive: true }
    )

    const result = await makeService(crash.fixture).restore(crash.request)

    expect(result).toMatchObject({
      status: 'failed', rollback: 'not-required', errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED',
      maintenanceRequired: true, auditStored: false
    })
    expect(await readPair(crash.fixture)).toEqual(pairBefore)
    expect(await readRestoreStage(crash.stage)).toEqual(stageBefore)
    expect(await readLatestTestRestoreJournal(crash.fixture.saveRoot, crash.request.requestId))
      .toEqual(crash.journal)
  })

  it('finishes owned post-commit GC without overwriting a live pair that advanced after restart', async () => {
    const fixture = await seedPair(
      'Committed_Then_Advanced',
      Buffer.from('fictional-restored-dsv'),
      Buffer.from('fictional-restored-server')
    )
    const service = makeService(fixture)
    const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    await writePair(
      fixture,
      Buffer.from('fictional-before-restore-dsv'),
      Buffer.from('fictional-before-restore-server')
    )
    const before = await service.inspect(fixture.saveName)
    const request = {
      requestId: randomUUID(),
      backupId: source.backupId,
      expectedRevision: before.revision,
      protectionRequestId: randomUUID()
    }
    const faulting = makeService(fixture, {
      hooks: (phase) => {
        if (phase === 'after-receipt') throw new Error('fictional post-commit crash')
      }
    })
    const committed = await faulting.restore(request)
    expect(committed).toMatchObject({ status: 'succeeded', reused: false })
    const advanced = {
      dsv: Buffer.from('fictional-subsequent-live-dsv'),
      server: Buffer.from('fictional-subsequent-live-server')
    }
    await writePair(fixture, advanced.dsv, advanced.server)

    const replay = await makeService(fixture).restore(request)

    expect(replay).toMatchObject({
      status: 'succeeded',
      reused: true,
      rollback: 'not-required',
      afterRevision: committed.afterRevision,
      pairBytes: committed.pairBytes
    })
    expect(await readPair(fixture)).toEqual(advanced)
    await expectRestoreJournalAbsent(fixture.saveRoot, request.requestId)
    for (const artifact of [
      path.join(fixture.saveRoot, `.rollback-${request.requestId}-dsv.bin`),
      path.join(fixture.saveRoot, `.rollback-${request.requestId}-server.bin`),
      path.join(fixture.saveRoot, `.restore-stage-${request.requestId}`)
    ]) {
      await expect(stat(artifact)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('blocks unrelated backup and restore requests while another restore journal is unresolved', async () => {
    const crash = await seedPreparedRestoreCrash('Global_Journal_Gate')
    const pairBefore = await readPair(crash.fixture)
    const journalBefore = await readFile(crash.journalPath)
    const stageBefore = await readRestoreStage(crash.stage)
    const auditRoot = path.join(crash.fixture.saveRoot, '.dyson-save-control', 'audit')
    const auditsBefore = (await readdir(auditRoot)).sort()
    const backupRequestId = randomUUID()
    const restoreRequestId = randomUUID()
    const unrelatedProtectionId = randomUUID()

    const blockedBackup = await makeService(crash.fixture).backup({
      requestId: backupRequestId,
      saveName: crash.fixture.saveName
    })
    const blockedRestore = await makeService(crash.fixture).restore({
      requestId: restoreRequestId,
      backupId: crash.request.backupId,
      expectedRevision: crash.request.expectedRevision,
      protectionRequestId: unrelatedProtectionId
    })

    expect(blockedBackup).toMatchObject({ status: 'busy', errorCode: 'SAVE_TRANSACTION_BUSY', auditStored: false })
    expect(blockedRestore).toMatchObject({ status: 'busy', errorCode: 'SAVE_TRANSACTION_BUSY', auditStored: false })
    expect(await readPair(crash.fixture)).toEqual(pairBefore)
    expect(await readFile(crash.journalPath)).toEqual(journalBefore)
    expect(await readRestoreStage(crash.stage)).toEqual(stageBefore)
    expect((await readdir(auditRoot)).sort()).toEqual(auditsBefore)
    await expect(stat(path.join(crash.fixture.backupRoot, `tx-${backupRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(crash.fixture.backupRoot, `tx-${unrelatedProtectionId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  for (const leaseScenario of [
    {
      name: 'a live PID with a mismatched boot identity',
      values: { pid: process.pid, bootId: `old-boot-${randomUUID()}`, acquiredAt: new Date().toISOString() }
    },
    {
      name: 'a dead PID on the same host',
      values: { pid: 2_147_483_647, bootId: `dead-pid-${randomUUID()}`, acquiredAt: new Date().toISOString() }
    },
    {
      name: 'an old acquisition timestamp',
      values: { pid: process.pid, bootId: `old-time-${randomUUID()}`, acquiredAt: '2000-01-01T00:00:00.000Z' }
    }
  ]) {
    it(`never takes over an existing lease with ${leaseScenario.name}`, async () => {
      const fixture = await seedPair(`Lease_${leaseScenario.name.replaceAll(' ', '_')}`, Buffer.from('dsv'), Buffer.from('server'))
      const controlRoot = path.join(fixture.saveRoot, '.dyson-save-control')
      const lockPath = path.join(controlRoot, 'transaction.lock')
      await mkdir(controlRoot)
      const lease = {
        format: 'dyson-control-save-transaction-lease',
        schemaVersion: 1,
        host: hostname(),
        ...leaseScenario.values,
        instanceId: randomUUID(),
        requestId: randomUUID()
      }
      await writeFile(lockPath, `${JSON.stringify(lease)}\n`, 'utf8')

      const result = await makeService(fixture).backup({ requestId: randomUUID(), saveName: fixture.saveName })

      expect(result).toMatchObject({ status: 'busy', errorCode: 'SAVE_TRANSACTION_BUSY', auditStored: false })
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(lease)
    })
  }

  it('retains a non-exact lease instead of guessing that it is stale', async () => {
    const fixture = await seedPair('Lease_Exact_Schema', Buffer.from('dsv'), Buffer.from('server'))
    const controlRoot = path.join(fixture.saveRoot, '.dyson-save-control')
    const lockPath = path.join(controlRoot, 'transaction.lock')
    await mkdir(controlRoot)
    const malformedLease = {
      format: 'dyson-control-save-transaction-lease',
      schemaVersion: 1,
      host: hostname(),
      bootId: `stale-${randomUUID()}`,
      pid: process.pid,
      instanceId: randomUUID(),
      requestId: randomUUID(),
      acquiredAt: new Date().toISOString(),
      unexpected: true
    }
    await writeFile(lockPath, `${JSON.stringify(malformedLease)}\n`, 'utf8')

    const result = await makeService(fixture).backup({ requestId: randomUUID(), saveName: fixture.saveName })

    expect(result).toMatchObject({ status: 'busy', errorCode: 'SAVE_TRANSACTION_BUSY' })
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(malformedLease)
  })

  it('does not unlink a replacement lease when initial lease persistence fails', async () => {
    const fixture = await seedPair('Lease_Create_Failure', Buffer.from('dsv'), Buffer.from('server'))
    const lockPath = path.join(fixture.saveRoot, '.dyson-save-control', 'transaction.lock')
    const replacement = {
      format: 'dyson-control-save-transaction-lease',
      schemaVersion: 1,
      host: hostname(),
      bootId: `replacement-${randomUUID()}`,
      pid: process.pid,
      instanceId: randomUUID(),
      requestId: randomUUID(),
      acquiredAt: new Date().toISOString()
    }
    let injected = false

    const failed = await makeService(fixture, {
      hooks: async (phase) => {
        if (phase !== 'after-lease-created-before-write' || injected) return
        injected = true
        await rm(lockPath)
        await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, 'utf8')
        throw new Error('fictional lease persistence failure after pathname replacement')
      }
    }).backup({ requestId: randomUUID(), saveName: fixture.saveName })

    expect(injected).toBe(true)
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE' })
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(replacement)

    const blocked = await makeService(fixture).backup({ requestId: randomUUID(), saveName: fixture.saveName })
    expect(blocked).toMatchObject({ status: 'busy', errorCode: 'SAVE_TRANSACTION_BUSY' })
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(replacement)
  })

  it('does not release a lease whose instance identity was replaced', async () => {
    const fixture = await seedPair('Lease_Owner', Buffer.from('dsv'), Buffer.from('server'))
    let replacement: Record<string, unknown> | null = null
    const service = makeService(fixture, {
      hooks: async (phase) => {
        if (phase !== 'backup-staged' || replacement !== null) return
        const lockPath = path.join(fixture.saveRoot, '.dyson-save-control', 'transaction.lock')
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>
        replacement = { ...current, instanceId: randomUUID() }
        await writeFile(lockPath, JSON.stringify(replacement), 'utf8')
      }
    })

    expect((await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })).status).toBe('succeeded')

    const persisted = JSON.parse(await readFile(
      path.join(fixture.saveRoot, '.dyson-save-control', 'transaction.lock'),
      'utf8'
    )) as Record<string, unknown>
    expect(persisted).toEqual(replacement)
  })

  it('does not release an exact-content replacement of its open lease file', async () => {
    const fixture = await seedPair('Lease_Exact_Copy_Replacement', Buffer.from('dsv'), Buffer.from('server'))
    const lockPath = path.join(fixture.saveRoot, '.dyson-save-control', 'transaction.lock')
    let replacementBytes: Buffer | null = null
    const service = makeService(fixture, {
      hooks: async (phase) => {
        if (phase !== 'backup-staged' || replacementBytes !== null) return
        replacementBytes = await readFile(lockPath)
        await rm(lockPath)
        await writeFile(lockPath, replacementBytes)
      }
    })

    expect((await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })).status)
      .toBe('succeeded')
    expect(replacementBytes).not.toBeNull()
    expect(await readFile(lockPath)).toEqual(replacementBytes)
  })
})

interface Fixture {
  root: string
  saveRoot: string
  backupRoot: string
  saveName: string
}

interface ServiceOverrides {
  gate?: (signal?: AbortSignal) => Promise<unknown>
  hooks?: (phase: SaveTransactionHookPhase) => void | Promise<void>
  snapshotAttempts?: number
  wait?: (milliseconds: number) => Promise<void>
}

interface PreparedRestoreCrash {
  fixture: Fixture
  request: {
    requestId: string
    backupId: string
    expectedRevision: string
    protectionRequestId: string
  }
  journal: TestRestoreJournalEnvelope
  journalPath: string
  stage: string
}

interface CompleteAfterRestoreCrash {
  fixture: Fixture
  request: PreparedRestoreCrash['request']
  protectedPair: { dsv: Buffer; server: Buffer }
  restoredPair: { dsv: Buffer; server: Buffer }
}

interface TestRestoreJournalEnvelope {
  format: 'dyson-control-save-restore-journal-envelope'
  schemaVersion: 1
  slot: 'a' | 'b'
  sequence: number
  previousDigest: string | null
  requestId: string
  backupId: string
  protectionBackupId: string
  saveName: string
  beforeRevision: string
  afterRevision: string
  phase: string
  recoveryFromPhase?: string
  updatedAt: string
  digest: string
}

async function seedPair(saveName: string, dsv: Buffer, server: Buffer): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-save-transactions-'))
  temporaryRoots.push(root)
  const saveRoot = path.join(root, 'Save')
  const backupRoot = path.join(root, 'backups')
  await Promise.all([mkdir(saveRoot), mkdir(backupRoot)])
  const fixture = { root, saveRoot, backupRoot, saveName }
  await writePair(fixture, dsv, server)
  return fixture
}

function makeService(fixture: Fixture, overrides: ServiceOverrides = {}): SaveTransactionService {
  return new SaveTransactionService({
    saveRoot: fixture.saveRoot,
    backupRoot: fixture.backupRoot,
    verifyServiceStopped: overrides.gate ?? (async () => stoppedEvidence),
    stableWindowMs: 0,
    snapshotAttempts: overrides.snapshotAttempts ?? 2,
    wait: overrides.wait ?? (async () => undefined),
    testHooks: overrides.hooks === undefined ? undefined : { onPhase: overrides.hooks }
  })
}

async function seedPreparedRestoreCrash(saveName: string): Promise<PreparedRestoreCrash> {
  const fixture = await seedPair(
    saveName,
    Buffer.from('fictional-restore-source-dsv'),
    Buffer.from('fictional-restore-source-server')
  )
  const service = makeService(fixture)
  const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
  await writePair(
    fixture,
    Buffer.from('fictional-protected-current-dsv'),
    Buffer.from('fictional-protected-current-server')
  )
  const before = await service.inspect(fixture.saveName)
  const request = {
    requestId: randomUUID(),
    backupId: source.backupId,
    expectedRevision: before.revision,
    protectionRequestId: randomUUID()
  }
  const protection = await service.backup({
    requestId: request.protectionRequestId,
    saveName: fixture.saveName
  })
  if (source.afterRevision === undefined || protection.afterRevision !== before.revision) {
    throw new Error('fixture setup failed')
  }
  const stage = path.join(fixture.saveRoot, `.restore-stage-${request.requestId}`)
  await mkdir(stage)
  await Promise.all([
    copyFile(
      path.join(fixture.backupRoot, source.backupId, `${fixture.saveName}.dsv`),
      path.join(stage, 'pair.dsv')
    ),
    copyFile(
      path.join(fixture.backupRoot, source.backupId, `${fixture.saveName}.server`),
      path.join(stage, 'pair.server')
    )
  ])
  const journal = testRestoreJournalEnvelope({
    requestId: request.requestId,
    backupId: request.backupId,
    protectionBackupId: `tx-${request.protectionRequestId}`,
    saveName: fixture.saveName,
    beforeRevision: request.expectedRevision,
    afterRevision: source.afterRevision,
    phase: 'prepared',
    updatedAt: new Date().toISOString()
  })
  const journalPath = testRestoreJournalPath(fixture.saveRoot, request.requestId, journal.slot)
  await writeFile(journalPath, `${JSON.stringify(journal)}\n`, 'utf8')
  return { fixture, request, journal, journalPath, stage }
}

async function seedCompleteAfterRestoreCrash(saveName: string): Promise<CompleteAfterRestoreCrash> {
  const restoredPair = {
    dsv: Buffer.from('fictional-complete-after-dsv'),
    server: Buffer.from('fictional-complete-after-server')
  }
  const protectedPair = {
    dsv: Buffer.from('fictional-complete-before-dsv'),
    server: Buffer.from('fictional-complete-before-server')
  }
  const fixture = await seedPair(saveName, restoredPair.dsv, restoredPair.server)
  const service = makeService(fixture)
  const source = await service.backup({ requestId: randomUUID(), saveName: fixture.saveName })
  await writePair(fixture, protectedPair.dsv, protectedPair.server)
  const before = await service.inspect(fixture.saveName)
  const request = {
    requestId: randomUUID(),
    backupId: source.backupId,
    expectedRevision: before.revision,
    protectionRequestId: randomUUID()
  }
  let commitFault = false
  let compensationEntryFault = false
  const interrupted = await makeService(fixture, {
    hooks: (phase) => {
      if (phase === 'after-restored-server-installed' && !commitFault) {
        commitFault = true
        throw new Error('leave a complete after pair before the receipt commit point')
      }
      if (phase === 'before-rollback' && !compensationEntryFault) {
        compensationEntryFault = true
        throw new Error('simulate process loss before durable compensation starts')
      }
    }
  }).restore(request)
  if (interrupted.status !== 'rollback-failed' || !commitFault || !compensationEntryFault) {
    throw new Error('complete-after crash fixture setup failed')
  }
  const current = await readPair(fixture)
  if (!current.dsv.equals(restoredPair.dsv) || !current.server.equals(restoredPair.server)) {
    throw new Error('complete-after crash fixture did not retain the restored pair')
  }
  return { fixture, request, protectedPair, restoredPair }
}

function testRestoreJournalEnvelope(
  payload: Omit<TestRestoreJournalEnvelope,
    'format' | 'schemaVersion' | 'slot' | 'sequence' | 'previousDigest' | 'digest'>,
  previous: TestRestoreJournalEnvelope | null = null
): TestRestoreJournalEnvelope {
  const body = {
    format: 'dyson-control-save-restore-journal-envelope' as const,
    schemaVersion: 1 as const,
    slot: previous?.slot === 'a' ? 'b' as const : 'a' as const,
    sequence: previous === null ? 1 : previous.sequence + 1,
    previousDigest: previous?.digest ?? null,
    requestId: payload.requestId,
    backupId: payload.backupId,
    protectionBackupId: payload.protectionBackupId,
    saveName: payload.saveName,
    beforeRevision: payload.beforeRevision,
    afterRevision: payload.afterRevision,
    phase: payload.phase,
    ...(payload.recoveryFromPhase === undefined ? {} : { recoveryFromPhase: payload.recoveryFromPhase }),
    updatedAt: payload.updatedAt
  }
  return {
    ...body,
    digest: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')
  }
}

function redigestTestRestoreJournal(
  journal: TestRestoreJournalEnvelope,
  patch: Partial<Omit<TestRestoreJournalEnvelope, 'digest'>>
): TestRestoreJournalEnvelope {
  const { digest: _ignored, ...body } = { ...journal, ...patch }
  return {
    ...body,
    digest: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')
  }
}

function testRestoreJournalPath(saveRoot: string, requestId: string, slot: 'a' | 'b'): string {
  return path.join(
    saveRoot,
    '.dyson-save-control',
    'restore-journals',
    `restore-${requestId}-${slot}.json`
  )
}

function testRestoreJournalCandidatePath(saveRoot: string, requestId: string, slot: 'a' | 'b'): string {
  return path.join(
    saveRoot,
    '.dyson-save-control',
    'restore-journals',
    `restore-${requestId}-${slot}.candidate.json`
  )
}

async function readLatestTestRestoreJournal(
  saveRoot: string,
  requestId: string
): Promise<TestRestoreJournalEnvelope> {
  const candidates = await Promise.all([
    testRestoreJournalPath(saveRoot, requestId, 'a'),
    testRestoreJournalPath(saveRoot, requestId, 'b'),
    testRestoreJournalCandidatePath(saveRoot, requestId, 'a'),
    testRestoreJournalCandidatePath(saveRoot, requestId, 'b')
  ].map(async (candidate) => {
    try {
      return JSON.parse(await readFile(candidate, 'utf8')) as TestRestoreJournalEnvelope
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null
      throw error
    }
  }))
  const records = candidates.filter((candidate): candidate is TestRestoreJournalEnvelope => candidate !== null)
  if (records.length === 0) throw new Error(`restore journal missing: ${requestId}`)
  return records.sort((left, right) => right.sequence - left.sequence)[0]!
}

async function expectRestoreJournalAbsent(saveRoot: string, requestId: string): Promise<void> {
  for (const candidate of [
    testRestoreJournalPath(saveRoot, requestId, 'a'),
    testRestoreJournalPath(saveRoot, requestId, 'b'),
    testRestoreJournalCandidatePath(saveRoot, requestId, 'a'),
    testRestoreJournalCandidatePath(saveRoot, requestId, 'b')
  ]) await expect(stat(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function snapshotRestoreJournalEvidence(
  saveRoot: string,
  requestId: string
): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {}
  for (const candidate of [
    testRestoreJournalPath(saveRoot, requestId, 'a'),
    testRestoreJournalPath(saveRoot, requestId, 'b'),
    testRestoreJournalCandidatePath(saveRoot, requestId, 'a'),
    testRestoreJournalCandidatePath(saveRoot, requestId, 'b')
  ]) {
    try {
      result[path.basename(candidate)] = await readFile(candidate)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
  }
  return result
}

async function writePair(fixture: Fixture, dsv: Buffer, server: Buffer): Promise<void> {
  await Promise.all([
    writeFile(path.join(fixture.saveRoot, `${fixture.saveName}.dsv`), dsv),
    writeFile(path.join(fixture.saveRoot, `${fixture.saveName}.server`), server)
  ])
}

async function readPair(fixture: Fixture): Promise<{ dsv: Buffer; server: Buffer }> {
  const [dsv, server] = await Promise.all([
    readFile(path.join(fixture.saveRoot, `${fixture.saveName}.dsv`)),
    readFile(path.join(fixture.saveRoot, `${fixture.saveName}.server`))
  ])
  return { dsv, server }
}

async function readRestoreStage(stage: string): Promise<{ dsv: Buffer; server: Buffer }> {
  const [dsv, server] = await Promise.all([
    readFile(path.join(stage, 'pair.dsv')),
    readFile(path.join(stage, 'pair.server'))
  ])
  return { dsv, server }
}

async function readAuditText(saveRoot: string): Promise<string> {
  const auditRoot = path.join(saveRoot, '.dyson-save-control', 'audit')
  const names = (await readdir(auditRoot)).sort()
  return (await Promise.all(names.map((name) => readFile(path.join(auditRoot, name), 'utf8')))).join('\n')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

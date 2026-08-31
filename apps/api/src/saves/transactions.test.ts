import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyBackupPair } from './backups.js'
import {
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
})

interface Fixture {
  root: string
  saveRoot: string
  backupRoot: string
  saveName: string
}

interface ServiceOverrides {
  gate?: () => Promise<unknown>
  hooks?: (phase: SaveTransactionHookPhase) => void | Promise<void>
  snapshotAttempts?: number
  wait?: (milliseconds: number) => Promise<void>
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

async function readAuditText(saveRoot: string): Promise<string> {
  const auditRoot = path.join(saveRoot, '.dyson-save-control', 'audit')
  const names = (await readdir(auditRoot)).sort()
  return (await Promise.all(names.map((name) => readFile(path.join(auditRoot, name), 'utf8')))).join('\n')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

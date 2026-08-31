import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectGameConfiguration, planGameConfiguration, type GameConfigFiles } from './planner.js'
import { GameConfigTransactionService } from './transaction.js'

const initialFiles: Readonly<Record<keyof GameConfigFiles, { name: string; content: string }>> = {
  nebula: {
    name: 'nebula.cfg',
    content: '\ufeff[Nebula - Settings]\r\n# preserve this comment\r\nAutoPauseEnabled = true\r\nServerPassword = fictional-old-secret\r\n'
  },
  galaxy: {
    name: 'nebulaGameDescSettings.cfg',
    content: '[Basic]\nstarCount = 64\nresourceMultiplier = 1\n\n[General]\nisPeaceMode = false\n'
  },
  bepinex: {
    name: 'BepInEx.cfg',
    content: '[Logging.Console]\r\nEnabled = false\r\n'
  },
  bridge: {
    name: 'io.github.mikutea.dyson-control-bridge.cfg',
    content: '[Bridge]\nEnabled = false\n\n[Timing]\nPollMilliseconds = 250\n'
  }
}

const temporaryRoots: string[] = []

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()!
    await rm(root, { recursive: true, force: true })
  }
})

describe('game configuration transaction', () => {
  it('applies an allowlisted plan, creates a verifiable snapshot, and emits only redacted audit data', async () => {
    const root = await seedRoot()
    const plan = await makePlan(root, [
      { id: 'nebula.server-password', value: 'fictional-new-secret' },
      { id: 'bepinex.console-enabled', value: true },
      { id: 'bridge.enabled', value: true }
    ])
    const service = new GameConfigTransactionService({ configRoot: root })

    const result = await service.apply(plan)

    expect(result).toMatchObject({ status: 'applied', auditStored: true })
    expect(result.snapshotId).toBe(result.transactionId)
    expect(await readFile(path.join(root, initialFiles.nebula.name), 'utf8'))
      .toContain('ServerPassword = fictional-new-secret')
    expect(await readFile(path.join(root, initialFiles.bepinex.name), 'utf8')).toContain('Enabled = true')
    expect(await service.verifySnapshot(result.snapshotId!)).toEqual({
      snapshotId: result.snapshotId,
      valid: true,
      beforeRevision: plan.baseRevision,
      fileCount: 4
    })

    const publicOutput = JSON.stringify(result)
    const auditOutput = await readAuditText(root)
    expect(publicOutput).not.toContain('fictional-new-secret')
    expect(publicOutput).not.toContain(root)
    expect(auditOutput).not.toContain('fictional-new-secret')
    expect(auditOutput).not.toContain('fictional-old-secret')
    expect(auditOutput).not.toContain(root)
    expect(auditOutput).toContain('nebula.server-password')
  })

  it('supports a durable audited dry-run without changing any configuration bytes', async () => {
    const root = await seedRoot()
    const before = await readAllBuffers(root)
    const plan = await makePlan(root, [{ id: 'galaxy.resource-multiplier', value: 8 }])
    const service = new GameConfigTransactionService({ configRoot: root })

    const result = await service.apply(plan, { dryRun: true })

    expect(result).toMatchObject({ status: 'dry-run', dryRun: true, auditStored: true })
    expect(result.snapshotId).toBeUndefined()
    expectBuffersEqual(await readAllBuffers(root), before)
    expect(await readAuditText(root)).toContain('"status":"dry-run"')
  })

  it('revalidates the optimistic revision while holding the lock', async () => {
    const root = await seedRoot()
    const plan = await makePlan(root, [{ id: 'nebula.auto-pause', value: false }])
    await writeFile(
      path.join(root, initialFiles.galaxy.name),
      `${initialFiles.galaxy.content}# changed by another administrator\n`,
      'utf8'
    )
    const service = new GameConfigTransactionService({ configRoot: root })

    const result = await service.apply(plan)

    expect(result).toMatchObject({
      status: 'revision-conflict',
      errorCode: 'CONFIG_REVISION_CONFLICT',
      auditStored: true
    })
    expect(await readFile(path.join(root, initialFiles.nebula.name), 'utf8'))
      .toContain('AutoPauseEnabled = true')
  })

  it('returns busy for a concurrent process-local contender while the first transaction owns the lock', async () => {
    const root = await seedRoot()
    const plan = await makePlan(root, [{ id: 'bepinex.console-enabled', value: true }])
    let enterFirstReplace!: () => void
    let releaseFirstReplace!: () => void
    const entered = new Promise<void>((resolve) => { enterFirstReplace = resolve })
    const release = new Promise<void>((resolve) => { releaseFirstReplace = resolve })
    const first = new GameConfigTransactionService({
      configRoot: root,
      testHooks: {
        async onPhase(phase, detail) {
          if (phase === 'before-replace' && detail.index === 0) {
            enterFirstReplace()
            await release
          }
        }
      }
    })
    const contender = new GameConfigTransactionService({ configRoot: root })

    const firstResultPromise = first.apply(plan)
    await entered
    const contenderResult = await contender.apply(plan)
    releaseFirstReplace()
    const firstResult = await firstResultPromise

    expect(contenderResult).toMatchObject({ status: 'busy', errorCode: 'CONFIG_TRANSACTION_BUSY' })
    expect(firstResult.status).toBe('applied')
  })

  it('fails closed when the durable lock is already owned by another process', async () => {
    const root = await seedRoot()
    const plan = await makePlan(root, [{ id: 'bridge.enabled', value: true }])
    const service = new GameConfigTransactionService({ configRoot: root })
    expect((await service.apply(plan, { dryRun: true })).status).toBe('dry-run')
    await writeFile(
      path.join(root, '.dyson-control', 'configuration.lock'),
      '{"schemaVersion":1,"transactionId":"external-process"}',
      'utf8'
    )

    const result = await service.apply(plan)

    expect(result).toMatchObject({
      status: 'busy',
      errorCode: 'CONFIG_TRANSACTION_BUSY',
      auditStored: false
    })
    expect(await readFile(path.join(root, initialFiles.bridge.name), 'utf8')).toContain('Enabled = false')
  })

  it('automatically restores every original byte after a partial multi-file commit failure', async () => {
    const root = await seedRoot()
    const before = await readAllBuffers(root)
    const plan = await makePlan(root, [
      { id: 'nebula.server-password', value: 'must-never-enter-audit' },
      { id: 'galaxy.resource-multiplier', value: 5 },
      { id: 'bepinex.console-enabled', value: true },
      { id: 'bridge.enabled', value: true }
    ])
    const service = new GameConfigTransactionService({
      configRoot: root,
      testHooks: {
        onPhase(phase, detail) {
          if (phase === 'before-replace' && detail.index === 1) {
            throw new Error('fault detail must not escape')
          }
        }
      }
    })

    const result = await service.apply(plan)

    expect(result).toMatchObject({
      status: 'rolled-back',
      errorCode: 'CONFIG_COMMIT_FAILED',
      auditStored: true
    })
    expectBuffersEqual(await readAllBuffers(root), before)
    const serialized = `${JSON.stringify(result)}\n${await readAuditText(root)}`
    expect(serialized).not.toContain('must-never-enter-audit')
    expect(serialized).not.toContain('fault detail must not escape')
    expect(serialized).not.toContain(root)
    expect(await service.verifySnapshot(result.snapshotId!)).toMatchObject({ valid: true, fileCount: 4 })
  })

  it('reports rollback-failed distinctly when compensating restoration cannot complete', async () => {
    const root = await seedRoot()
    const plan = await makePlan(root, [
      { id: 'nebula.auto-pause', value: false },
      { id: 'galaxy.resource-multiplier', value: 3 }
    ])
    const service = new GameConfigTransactionService({
      configRoot: root,
      testHooks: {
        onPhase(phase, detail) {
          if (phase === 'before-replace' && detail.index === 1) throw new Error('commit fault')
          if (phase === 'before-restore' && detail.index === 0) throw new Error('restore fault')
        }
      }
    })

    const result = await service.apply(plan)

    expect(result).toMatchObject({
      status: 'rollback-failed',
      errorCode: 'CONFIG_ROLLBACK_FAILED',
      auditStored: true
    })
  })

  it('rejects plan-shaped content that changes anything outside catalog-generated patches', async () => {
    const root = await seedRoot()
    const validPlan = await makePlan(root, [{ id: 'nebula.auto-pause', value: false }])
    const files = {
      ...validPlan.files,
      nebula: `${validPlan.files.nebula!}ArbitraryCommand = forbidden\n`
    }
    const forgedPlan = {
      ...validPlan,
      files,
      nextRevision: inspectGameConfiguration(files).revision
    }
    const before = await readAllBuffers(root)
    const service = new GameConfigTransactionService({ configRoot: root })

    const result = await service.apply(forgedPlan)

    expect(result).toMatchObject({ status: 'rejected', errorCode: 'CONFIG_PLAN_NOT_ALLOWLISTED' })
    expectBuffersEqual(await readAllBuffers(root), before)
  })

  it('detects a corrupted snapshot without returning its hashes or contents', async () => {
    const root = await seedRoot()
    const plan = await makePlan(root, [{ id: 'bridge.enabled', value: true }])
    const service = new GameConfigTransactionService({ configRoot: root })
    const result = await service.apply(plan)
    expect(result.status).toBe('applied')
    const snapshotId = result.snapshotId!
    await writeFile(
      path.join(root, '.dyson-control', 'snapshots', snapshotId, 'nebula.bin'),
      'tampered',
      'utf8'
    )

    const verification = await service.verifySnapshot(snapshotId)

    expect(verification).toEqual({ snapshotId, valid: false, beforeRevision: null, fileCount: 0 })
    expect(JSON.stringify(verification)).not.toContain('sha256')
  })
})

async function seedRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-config-transaction-'))
  temporaryRoots.push(root)
  await Promise.all(Object.values(initialFiles).map((file) =>
    writeFile(path.join(root, file.name), file.content, 'utf8')
  ))
  return root
}

async function readPlannerFiles(root: string): Promise<GameConfigFiles> {
  return Object.fromEntries(await Promise.all(
    Object.entries(initialFiles).map(async ([id, file]) => [
      id,
      await readFile(path.join(root, file.name), 'utf8')
    ])
  )) as GameConfigFiles
}

async function makePlan(
  root: string,
  changes: ReadonlyArray<{ id: string; value: unknown }>
) {
  const files = await readPlannerFiles(root)
  return planGameConfiguration(files, inspectGameConfiguration(files).revision, changes)
}

async function readAllBuffers(root: string): Promise<Record<string, Buffer>> {
  return Object.fromEntries(await Promise.all(
    Object.entries(initialFiles).map(async ([id, file]) => [id, await readFile(path.join(root, file.name))])
  ))
}

function expectBuffersEqual(actual: Record<string, Buffer>, expected: Record<string, Buffer>): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  for (const id of Object.keys(expected)) expect(actual[id]!.equals(expected[id]!)).toBe(true)
}

async function readAuditText(root: string): Promise<string> {
  const auditRoot = path.join(root, '.dyson-control', 'audit')
  const names = (await readdir(auditRoot)).sort()
  return (await Promise.all(names.map((name) => readFile(path.join(auditRoot, name), 'utf8')))).join('\n')
}

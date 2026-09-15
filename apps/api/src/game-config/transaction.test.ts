import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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
    const original = await readAllBuffers(root)
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
    const afterFailure = await readAllBuffers(root)
    const contender = new GameConfigTransactionService({ configRoot: root })
    expect(await contender.apply(await makePlan(root, [{ id: 'bridge.enabled', value: true }])))
      .toMatchObject({ status: 'busy', auditStored: false })
    expectBuffersEqual(await readAllBuffers(root), afterFailure)
    expect(await contender.reconcile(result.transactionId, {
      recoveryRequestId: result.transactionId, signal: new AbortController().signal,
      assertActive() {}, toPowerShellBorrowArguments: () => []
    }, async () => {})).toMatchObject({ status: 'rolled-back', auditStored: true })
    expectBuffersEqual(await readAllBuffers(root), original)
  })

  it('persists redacted permitted byte states before replacing any live file', async () => {
    const root = await seedRoot()
    const transactionId = randomUUID()
    const before = await readAllBuffers(root)
    const plan = await makePlan(root, [{ id: 'nebula.server-password', value: 'fictional-next-secret' }])
    let inspected = false
    const service = new GameConfigTransactionService({
      configRoot: root,
      testHooks: { async onPhase(phase, detail) {
        if (phase !== 'before-replace' || detail.index !== 0) return
        const raw = await readFile(path.join(root, '.dyson-control', 'snapshots', transactionId, 'apply-intent.json'), 'utf8')
        const intent = JSON.parse(raw)
        expect(raw).not.toContain('fictional-next-secret')
        expect(raw).not.toContain('fictional-old-secret')
        expect(raw).not.toContain(root)
        expect(intent).toMatchObject({ transactionId, baseRevision: plan.baseRevision, nextRevision: plan.nextRevision })
        for (const file of intent.files) {
          expect(file.beforeSha256).toBe(createHash('sha256').update(before[file.id]!).digest('hex'))
          expect(file.afterSha256).toBe(createHash('sha256').update(plan.files[file.id as keyof GameConfigFiles]!).digest('hex'))
        }
        expectBuffersEqual(await readAllBuffers(root), before)
        inspected = true
      } }
    })
    expect(await service.apply(plan, { transactionId })).toMatchObject({ status: 'applied', auditStored: true })
    expect(inspected).toBe(true)
  })

  it('quarantines an applied transaction when its terminal audit cannot be persisted', async () => {
    const root = await seedRoot()
    const transactionId = randomUUID()
    const plan = await makePlan(root, [{ id: 'bridge.enabled', value: true }])
    const service = new GameConfigTransactionService({
      configRoot: root,
      testHooks: { async onPhase(phase) {
        if (phase === 'before-verify') {
          await mkdir(path.join(root, '.dyson-control', 'audit', `${transactionId}-1-applied.json`))
        }
      } }
    })
    expect(await service.apply(plan, { transactionId })).toMatchObject({ status: 'applied', auditStored: false })
    const lock = JSON.parse(await readFile(path.join(root, '.dyson-control', 'configuration.lock'), 'utf8'))
    expect(lock).toMatchObject({ schemaVersion: 2, transactionId, pid: process.pid, action: 'game-config.apply' })
    const afterFailure = await readAllBuffers(root)
    expect(await new GameConfigTransactionService({ configRoot: root }).apply(
      await makePlan(root, [{ id: 'bridge.enabled', value: false }])
    )).toMatchObject({ status: 'busy' })
    expectBuffersEqual(await readAllBuffers(root), afterFailure)
  })

  it.each(['lock-acquired', 'snapshot-file-written', 'snapshot-created', 'before-replace', 'after-replace', 'before-verify', 'terminal-persisted'])(
    'retains matching recovery evidence and rejects further writes after process exit at %s', async phase => {
      const root = await seedRoot()
      const transactionId = randomUUID()
      const before = await readAllBuffers(root)
      const plan = await makePlan(root, [
        { id: 'nebula.auto-pause', value: false },
        { id: 'bridge.enabled', value: true }
      ])
      const source = new URL('./transaction.ts', import.meta.url).href
      const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
      const program = `
        import { GameConfigTransactionService } from ${JSON.stringify(source)};
        const input = JSON.parse(process.argv[1]);
        const service = new GameConfigTransactionService({ configRoot: input.root,
          testHooks: { onPhase(phase) { if (phase === input.phase) process.exit(75) } }
        });
        await service.apply(input.plan, { transactionId: input.transactionId });
        process.exit(76);
      `
      const child = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval', program,
        JSON.stringify({ root, transactionId, plan, phase })],
      { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
      expect(child.status, child.stderr).toBe(75)
      const lockBytes = await readFile(path.join(root, '.dyson-control', 'configuration.lock'))
      const intentPath = path.join(root, '.dyson-control', 'snapshots', transactionId, 'apply-intent.json')
      const early = ['lock-acquired', 'snapshot-file-written', 'snapshot-created'].includes(phase)
      const intent = early ? null : JSON.parse(await readFile(intentPath, 'utf8'))
      if (intent) expect(intent.lockSha256).toBe(createHash('sha256').update(lockBytes).digest('hex'))
      else await expect(readFile(intentPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const afterExit = await readAllBuffers(root)
      expect(afterExit.nebula!.equals(before.nebula!)).toBe(early || phase === 'before-replace')
      expect(afterExit.bridge!.equals(before.bridge!)).toBe(!['before-verify', 'terminal-persisted'].includes(phase))
      for (const file of intent?.files ?? []) {
        const actual = createHash('sha256').update(afterExit[file.id]!).digest('hex')
        expect([file.beforeSha256, file.afterSha256]).toContain(actual)
      }
      const service = new GameConfigTransactionService({ configRoot: root })
      expect(await service.verifySnapshot(transactionId)).toMatchObject(
        ['lock-acquired', 'snapshot-file-written'].includes(phase)
          ? { valid: false } : { valid: true, beforeRevision: plan.baseRevision })
      expect(await service.apply(plan, { transactionId })).toMatchObject({ status: 'busy' })
      expectBuffersEqual(await readAllBuffers(root), afterExit)
      const scope = { signal: new AbortController().signal, assertActive() {},
        toPowerShellBorrowArguments: () => [], recoveryRequestId: transactionId }
      await expect(service.reconcile(transactionId, { ...scope, recoveryRequestId: randomUUID() }, async () => {}))
        .rejects.toMatchObject({ code: 'CONFIG_RECOVERY_INVALID' })
      expectBuffersEqual(await readAllBuffers(root), afterExit)
      if (early) {
        const staged = path.join(root, `.nebula.cfg.${transactionId}.apply.tmp`)
        await writeFile(staged, 'unexpected staged bytes')
        await expect(service.reconcile(transactionId, scope, async () => {}))
          .rejects.toMatchObject({ code: 'CONFIG_RECOVERY_INVALID' })
        expectBuffersEqual(await readAllBuffers(root), afterExit)
        await rm(staged)
      }
      if (phase === 'snapshot-file-written') {
        const fragment = path.join(root, '.dyson-control', 'snapshots', transactionId, 'nebula.bin')
        await writeFile(fragment, 'foreign snapshot fragment')
        await expect(service.reconcile(transactionId, scope, async () => {}))
          .rejects.toMatchObject({ code: 'CONFIG_RECOVERY_INVALID' })
        expect(await readFile(fragment, 'utf8')).toBe('foreign snapshot fragment')
        expectBuffersEqual(await readAllBuffers(root), before)
        await writeFile(fragment, before.nebula!)
      }
      if (phase === 'lock-acquired') {
        await writeFile(path.join(root, initialFiles.nebula.name), 'external revision\n')
        await expect(service.reconcile(transactionId, scope, async () => {}))
          .rejects.toMatchObject({ code: 'CONFIG_RECOVERY_INVALID' })
        expect(await readFile(path.join(root, initialFiles.nebula.name), 'utf8')).toBe('external revision\n')
        await writeFile(path.join(root, initialFiles.nebula.name), before.nebula!)
      }
      if (phase === 'after-replace') {
        await writeFile(path.join(root, initialFiles.nebula.name), 'unknown external bytes\n')
        const foreign = await readAllBuffers(root)
        await expect(service.reconcile(transactionId, scope, async () => {}))
          .rejects.toMatchObject({ code: 'CONFIG_RECOVERY_INVALID' })
        expectBuffersEqual(await readAllBuffers(root), foreign)
        expect(await readFile(path.join(root, '.dyson-control', 'configuration.lock'))).toEqual(lockBytes)
        await writeFile(path.join(root, initialFiles.nebula.name), afterExit.nebula!)

        const recoverProgram = `
          import { GameConfigTransactionService } from ${JSON.stringify(source)};
          const input = JSON.parse(process.argv[1]);
          const service = new GameConfigTransactionService({ configRoot: input.root,
            testHooks: { onPhase(phase, detail) {
              if (phase === 'before-restore' && detail.index === 1) process.exit(75);
            } }
          });
          await service.reconcile(input.transactionId, {
            recoveryRequestId: input.transactionId, signal: new AbortController().signal,
            assertActive() {}, toPowerShellBorrowArguments() { return [] }
          }, async () => {});
          process.exit(76);
        `
        const recoveryChild = spawnSync(process.execPath,
          ['--import', loader, '--input-type=module', '--eval', recoverProgram, JSON.stringify({ root, transactionId })],
          { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
        expect(recoveryChild.status, recoveryChild.stderr).toBe(75)
        expect(await readFile(path.join(root, '.dyson-control', 'configuration.lock'))).toEqual(lockBytes)
      }
      const restored = await service.reconcile(transactionId, scope, async () => {})
      const committed = phase === 'terminal-persisted'
      expect(restored).toMatchObject({ status: committed ? 'applied' : 'rolled-back',
        currentRevision: committed ? plan.nextRevision : plan.baseRevision, auditStored: true })
      expectBuffersEqual(await readAllBuffers(root), committed ? afterExit : before)
      // A later administrator edit must survive replay of the completed recovery.
      await writeFile(path.join(root, initialFiles.nebula.name), `${initialFiles.nebula.content}# later edit\n`)
      const later = await readAllBuffers(root)
      expect(await service.reconcile(transactionId, scope, async () => {})).toEqual(restored)
      expectBuffersEqual(await readAllBuffers(root), later)
    }
  )

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

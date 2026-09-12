import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SaveTransactionService } from './transactions.js'

const roots: string[] = []
const stopped = { protocol: 'DYSON_CONTROL_RUNTIME_V1', expected: 'stopped', state: 'matched',
  processVerified: true, gamePortListening: false }
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
const source = new URL('./transactions.ts', import.meta.url).href
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

describe('native save restore interruption', () => {
  it.each(['protection-created', 'after-original-dsv-moved', 'after-restored-dsv-installed', 'after-restored-server-installed'])(
    'reaches the correct durable terminal under exact authority after %s', async phase => {
      const root = await mkdtemp(path.join(path.resolve(os.tmpdir()), 'dyson-save-native-crash-'))
      roots.push(root)
      const saveRoot = path.join(root, 'Save'), backupRoot = path.join(root, 'backups')
      await mkdir(saveRoot); await mkdir(backupRoot)
      const name = 'Fictional'
      const pair = async (label: string) => {
        await writeFile(path.join(saveRoot, `${name}.dsv`), `${label}-dsv`)
        await writeFile(path.join(saveRoot, `${name}.server`), `${label}-server`)
      }
      const service = () => new SaveTransactionService({
        saveRoot, backupRoot, verifyServiceStopped: async () => stopped, stableWindowMs: 0
      })
      await pair('historical')
      const sourceBackup = await service().backup({ requestId: randomUUID(), saveName: name })
      await pair('current')
      const request = { requestId: randomUUID(), backupId: sourceBackup.backupId,
        expectedRevision: (await service().inspect(name)).revision, protectionRequestId: randomUUID() }
      const program = `
        import { SaveTransactionService } from ${JSON.stringify(source)};
        const input = JSON.parse(process.argv[1]);
        const service = new SaveTransactionService({
          saveRoot: input.saveRoot, backupRoot: input.backupRoot,
          verifyServiceStopped: async () => input.stopped, stableWindowMs: 0,
          testHooks: { onPhase(phase) { if (phase === input.phase) process.exit(75) } }
        });
        await service.restore(input.request);
        process.exit(76);
      `
      const child = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval', program,
        JSON.stringify({ saveRoot, backupRoot, stopped, phase, request })],
      { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
      expect(child.status, child.stderr).toBe(75)
      expect((await service().restore(request)).status).toBe('busy')
      const wrongScope = { signal: new AbortController().signal, assertActive() {}, recoveryRequestId: randomUUID() }
      expect((await service().restore(request, wrongScope)).status).toBe('busy')
      expect((await service().restore({ ...request, protectionRequestId: randomUUID() },
        { ...wrongScope, recoveryRequestId: request.requestId })).status).toBe('busy')
      const result = await service().restore(request, { ...wrongScope, recoveryRequestId: request.requestId })
      const resumed = phase === 'protection-created'
      const expectedPair = resumed ? 'historical' : 'current'
      expect(result.status).toBe(resumed ? 'succeeded' : 'rolled-back')
      expect(result.rollback).toBe(resumed ? 'not-required' : 'succeeded')
      expect(await readFile(path.join(saveRoot, `${name}.dsv`), 'utf8')).toBe(`${expectedPair}-dsv`)
      expect(await readFile(path.join(saveRoot, `${name}.server`), 'utf8')).toBe(`${expectedPair}-server`)
      const replay = await service().restore(request)
      expect(replay.reused).toBe(true)
      expect(await readFile(path.join(saveRoot, `${name}.dsv`), 'utf8')).toBe(`${expectedPair}-dsv`)
      if (!resumed) {
        const receiptPath = path.join(saveRoot, '.dyson-save-control', 'receipts', `restore-${request.requestId}.json`)
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
        receipt.afterRevision = `pair-v1:${'0'.repeat(64)}`
        await writeFile(receiptPath, JSON.stringify(receipt))
        await expect(service().restore(request)).rejects.toMatchObject({ code: 'SAVE_IDEMPOTENCY_CONFLICT' })
        expect(await readFile(path.join(saveRoot, `${name}.dsv`), 'utf8')).toBe('current-dsv')
      }
    }
  )
})

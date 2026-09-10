import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GameConfigHistoryService } from './history.js'
import { inspectGameConfiguration } from './planner.js'
import { HostMutationOperationCoordinatorError, type HostMutationRecoveryOperationRequest } from '../host-mutation/operation-coordinator.js'

describe('configuration history real process exit', () => {
  it.each(['after-target-read', 'before-protection', 'before-journal', 'after-displace-file', 'after-publish-file', 'before-lock-release', 'after-publish-no-lock'])(
    'recovers the original lock and receipt after %s', async phase => {
      const root = await mkdtemp(path.join(path.resolve(os.tmpdir()), 'dyson-history-hard-exit-'))
      try {
        const first = { nebula: '[Nebula - Settings]\nAutoPauseEnabled = true\n',
          bepinex: '[Logging.Console]\nEnabled = false\n', galaxy: null, bridge: null }
        await writeFile(path.join(root, 'nebula.cfg'), first.nebula)
        await writeFile(path.join(root, 'BepInEx.cfg'), first.bepinex)
        const capture = await new GameConfigHistoryService({ configRoot: root, validateStopProof: async () => true }).capture()
        const current = { ...first, nebula: first.nebula.replace('true', 'false'), bepinex: first.bepinex.replace('false', 'true') }
        await writeFile(path.join(root, 'nebula.cfg'), current.nebula)
        await writeFile(path.join(root, 'BepInEx.cfg'), current.bepinex)
        const request = { requestId: randomUUID(), snapshotId: capture.snapshotId,
          expectedCurrentRevision: inspectGameConfiguration(current).revision,
          stopProofToken: 'fictional-stop-proof', dryRun: false }
        const source = new URL('./history.ts', import.meta.url).href
        const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
        const program = `
          import { GameConfigHistoryService } from ${JSON.stringify(source)};
          const input = JSON.parse(process.argv[1]);
          const service = new GameConfigHistoryService({ configRoot: input.root, validateStopProof: async () => true,
            hostMutationCoordinator: { async runExclusive(request, action) {
              const result = await action({ signal: new AbortController().signal, assertActive() {}, toPowerShellBorrowArguments() { return [] } });
              if (result.kind === 'throw') throw result.error;
              return result.value;
            } }, testHooks: { onPhase(phase) { if (phase === input.phase) process.exit(75) } }
          });
          await service.restore(input.request);
          process.exit(76);
        `
        const child = spawnSync(process.execPath,
          ['--import', loader, '--input-type=module', '--eval', program, JSON.stringify({ root, request,
            phase: phase === 'after-publish-no-lock' ? 'after-publish-file' : phase })],
          { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
        expect(child.status, child.stderr).toBe(75)
        const lockPath = path.join(root, '.dyson-control', 'configuration.lock')
        const lockBytes = await readFile(lockPath)
        if (phase === 'after-displace-file') await expect(readFile(path.join(root, 'nebula.cfg'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(lockBytes.toString()).not.toContain('fictional-stop-proof')
        // Model a failed operation whose finally block released the local lock
        // while its global lease and durable journal still require recovery.
        if (phase === 'after-publish-no-lock') await rm(lockPath)
        const requests: HostMutationRecoveryOperationRequest[] = []
        const dispositions: string[] = []
        let mismatch = true
        const service = new GameConfigHistoryService({ configRoot: root, validateStopProof: async () => true,
          hostMutationCoordinator: { async runExclusive() { throw new Error('Must use original recovery authority') } },
          hostMutationRecoveryCoordinator: { async runRecoveryExclusive(request, action) {
            requests.push(request)
            if (mismatch) throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_MISMATCH')
            const result = await action({ signal: new AbortController().signal, assertActive() {}, toPowerShellBorrowArguments: () => [] })
            dispositions.push(result.disposition)
            if (result.kind === 'throw') throw result.error
            return result.value
          } }
        })
        await expect(service.reconcileInterrupted('fictional-stop-proof')).rejects.toThrow()
        if (phase === 'after-publish-no-lock') await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
        else expect(await readFile(lockPath)).toEqual(lockBytes)
        mismatch = false
        if (phase === 'after-displace-file') {
          const stagePath = path.join(root, '.dyson-control', 'config-history', 'pending', `restore-${request.requestId}`, 'target', 'nebula.bin')
          const staged = await readFile(stagePath)
          await writeFile(stagePath, 'unverified replacement')
          expect((await service.reconcileInterrupted('fictional-stop-proof'))[0]!.status).toBe('recovery-required')
          await expect(readFile(path.join(root, 'nebula.cfg'))).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await readFile(lockPath)).toEqual(lockBytes)
          await writeFile(stagePath, staged)
        }
        if (['after-target-read', 'before-protection', 'before-journal'].includes(phase)) {
          await writeFile(path.join(root, 'nebula.cfg'), 'external configuration revision\n')
          await expect(service.reconcileInterrupted('fictional-stop-proof')).rejects.toThrow()
          expect(await readFile(path.join(root, 'nebula.cfg'), 'utf8')).toBe('external configuration revision\n')
          expect(await readFile(lockPath)).toEqual(lockBytes)
          await writeFile(path.join(root, 'nebula.cfg'), current.nebula)
        }
        if (phase === 'after-publish-file') {
          const installed = await readFile(path.join(root, 'nebula.cfg'))
          await writeFile(path.join(root, 'nebula.cfg'), 'foreign administrator content\n')
          const refused = await service.reconcileInterrupted('fictional-stop-proof')
          expect(refused[0]!.status).toBe('recovery-required')
          expect(await readFile(path.join(root, 'nebula.cfg'), 'utf8')).toBe('foreign administrator content\n')
          expect(await readFile(lockPath)).toEqual(lockBytes)
          expect(dispositions.at(-1)).toBe('abandon')
          await writeFile(path.join(root, 'nebula.cfg'), installed)
        }
        const result = await service.reconcileInterrupted('fictional-stop-proof')
        expect(result[0]).toMatchObject({ requestId: request.requestId,
          status: phase === 'before-lock-release' ? 'committed-cleanup' : 'interrupted-recovered' })
        expect(dispositions.at(-1)).toBe('release')
        const expected = phase === 'before-lock-release' ? first : current
        expect(await readFile(path.join(root, 'nebula.cfg'), 'utf8')).toBe(expected.nebula)
        expect(await readFile(path.join(root, 'BepInEx.cfg'), 'utf8')).toBe(expected.bepinex)
        await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(requests.every(item => item.expectedOperation === 'game-config-restore' && item.expectedRequestId === request.requestId)).toBe(true)
        expect(await service.restore(request)).toMatchObject({ reused: true, persisted: true })
      } finally {
        if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture cleanup')
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

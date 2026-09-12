import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildApplication } from './app.js'
import { loadConfig } from './config.js'
import { inspectGameConfiguration, planGameConfiguration } from './game-config/planner.js'
import type { WindowsLifecycleBrokerClient } from './providers/windows-lifecycle-broker.js'
import { HostMutationOperationCoordinatorError, type HostMutationRecoveryOperationRequest } from './host-mutation/operation-coordinator.js'

describe('configuration recovery HTTP coordination', () => {
  it.each(['disabled', 'busy', 'running', 'stopped', 'not-required', 'mismatch'] as const)(
    'recovers a real interrupted transaction only with matching authority: %s', async mode => {
      const temporaryRoot = await realpath(os.tmpdir())
      const root = await mkdtemp(path.join(temporaryRoot, 'dyson-config-reconcile-route-'))
      const configRoot = path.join(root, 'server', 'BepInEx', 'config')
      await mkdir(configRoot, { recursive: true })
      const files = { nebula: '[Nebula - Settings]\nAutoPauseEnabled = true\n',
        bepinex: '[Logging.Console]\nEnabled = false\n', galaxy: null, bridge: null }
      await writeFile(path.join(configRoot, 'nebula.cfg'), files.nebula)
      await writeFile(path.join(configRoot, 'BepInEx.cfg'), files.bepinex)
      const requestId = randomUUID()
      const plan = planGameConfiguration(files, inspectGameConfiguration(files).revision,
        [{ id: 'nebula.auto-pause', value: false }, { id: 'bepinex.console-enabled', value: true }])
      const source = new URL('./game-config/transaction.ts', import.meta.url).href
      const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
      const program = `
        import { GameConfigTransactionService } from ${JSON.stringify(source)};
        const input = JSON.parse(process.argv[1]);
        const service = new GameConfigTransactionService({ configRoot: input.configRoot,
          testHooks: { onPhase(phase) { if (phase === 'after-replace') process.exit(75) } }
        });
        const result = await service.apply(input.plan, { transactionId: input.requestId });
        console.error(JSON.stringify({ status: result.status, errorCode: result.errorCode }));
        process.exit(76);
      `
      const child = spawnSync(process.execPath,
        ['--import', loader, '--input-type=module', '--eval', program, JSON.stringify({ configRoot, requestId, plan })],
        { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
      expect(child.status, child.stderr).toBe(75)
      const interrupted = await readFile(path.join(configRoot, 'nebula.cfg'), 'utf8')
      expect(interrupted).toContain('AutoPauseEnabled = false')
      const config = loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PROJECT_ROOT: root,
        DYSON_DATA_DIR: path.join(root, 'control'), DYSON_DEV_ADMIN_PASSWORD: 'fictional-recovery-password',
        DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010', DYSON_OBSERVABILITY_INTERVAL_MS: '0' })
      config.configMutationsEnabled = mode !== 'disabled'
      const requests: HostMutationRecoveryOperationRequest[] = []
      const dispositions: string[] = []
      let completed = false
      let proofs = 0
      const unused = async () => { throw new Error('Unexpected broker operation') }
      const broker = { preflight: unused, dispatch: unused, status: unused, verify: async () => {
        proofs++
        return { expected: 'stopped', matched: mode === 'stopped', blockers: [], runtime: {
          lifecycleState: 'stopped_verified', process: { status: 'absent', pid: null, owner: null, sessionId: null },
          port: { port: config.gamePort, listenerCount: 0 }, pidFile: { present: false, valid: false }
        } }
      } } as unknown as WindowsLifecycleBrokerClient
      const application = await buildApplication(config, { lifecycleBrokerClient: broker,
        hostMutationRecoveryCoordinator: { async runRecoveryExclusive(request, operation) {
          requests.push(request)
          if (mode === 'busy') throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_BUSY')
          if (mode === 'mismatch') throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_MISMATCH')
          if (mode === 'not-required' || completed) throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED')
          const result = await operation({ signal: new AbortController().signal,
            assertActive() {}, toPowerShellBorrowArguments: () => [] })
          dispositions.push(result.disposition)
          if (result.kind === 'throw') throw result.error
          completed = result.disposition === 'release'
          return result.value
        } }
      })
      try {
        const login = await application.app.inject({ method: 'POST', url: '/api/v1/auth/login',
          headers: { origin: config.publicOrigin }, payload: { password: 'fictional-recovery-password' } })
        expect(login.statusCode).toBe(200)
        const cookies = { dyson_session: login.cookies[0]!.value }
        const call = () => application.app.inject({ method: 'POST', url: '/api/v1/configuration/reconcile', cookies,
          headers: { origin: config.publicOrigin }, payload: { requestId, confirmation: 'RECONCILE_CONFIG' } })
        const response = await call()
        if (mode === 'stopped') {
          expect(response.statusCode, response.body).toBe(200)
          expect(response.json().data).toMatchObject({ transactionId: requestId, status: 'rolled-back', auditStored: true })
          expect(await readFile(path.join(configRoot, 'nebula.cfg'), 'utf8')).toBe(files.nebula)
          expect(await readFile(path.join(configRoot, 'BepInEx.cfg'), 'utf8')).toBe(files.bepinex)
          expect(dispositions).toEqual(['release'])
          expect(proofs).toBeGreaterThanOrEqual(4)
          await writeFile(path.join(configRoot, 'nebula.cfg'), `${files.nebula}# later administrator edit\n`)
          const replay = await call()
          expect(replay.statusCode, replay.body).toBe(200)
          expect(replay.json()).toEqual(response.json())
          expect(await readFile(path.join(configRoot, 'nebula.cfg'), 'utf8')).toContain('# later administrator edit')
        } else {
          expect(response.statusCode, response.body).toBe(mode === 'disabled' ? 423 : 503)
          expect(await readFile(path.join(configRoot, 'nebula.cfg'), 'utf8')).toBe(interrupted)
          expect(dispositions).toEqual(mode === 'running' ? ['abandon'] : [])
        }
        expect(requests).toEqual(Array.from({ length: mode === 'disabled' ? 0 : mode === 'stopped' ? 2 : 1 },
          () => ({ expectedOperation: 'game-config-apply', expectedRequestId: requestId })))
      } finally {
        await application.close()
        if (path.dirname(root) !== temporaryRoot) throw new Error('Unsafe fixture cleanup')
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

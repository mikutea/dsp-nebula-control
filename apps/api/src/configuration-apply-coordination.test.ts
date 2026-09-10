import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApplication } from './app.js'
import { loadConfig } from './config.js'
import type { WindowsLifecycleBrokerClient } from './providers/windows-lifecycle-broker.js'
import { HostMutationOperationCoordinatorError, type HostMutationOperationRequest } from './host-mutation/operation-coordinator.js'

describe('configuration apply coordination', () => {
  it.each(['disabled', 'lease-busy', 'running', 'stopped'] as const)(
    'allows real fixture configuration writes only behind every gate: %s', async mode => {
      const root = await mkdtemp(path.join(path.resolve(os.tmpdir()), 'dyson-config-route-'))
      const configRoot = path.join(root, 'server', 'BepInEx', 'config')
      await mkdir(configRoot, { recursive: true })
      const file = path.join(configRoot, 'nebula.cfg')
      const original = '[Nebula - Settings]\r\nAutoPauseEnabled = true\r\n'
      await writeFile(file, original)
      const config = loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PROJECT_ROOT: root,
        DYSON_DATA_DIR: path.join(root, 'control'), DYSON_DEV_ADMIN_PASSWORD: 'fictional-configuration-password',
        DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010', DYSON_OBSERVABILITY_INTERVAL_MS: '0' })
      // Inject boundary contracts without provisioning native Windows tasks.
      // Environment validation is tested independently in config.test.ts.
      config.configMutationsEnabled = mode !== 'disabled'
      const requests: HostMutationOperationRequest[] = []
      let proofs = 0
      const unusedBrokerMethod = async () => { throw new Error('Unexpected broker operation') }
      const broker = { preflight: unusedBrokerMethod, dispatch: unusedBrokerMethod, status: unusedBrokerMethod,
        verify: async () => {
        proofs++
        return { expected: 'stopped', matched: mode === 'stopped', blockers: [], runtime: {
          lifecycleState: 'stopped_verified', process: { status: 'absent', pid: null, owner: null, sessionId: null },
          port: { port: config.gamePort, listenerCount: 0 }, pidFile: { present: false, valid: false }
        } }
      } } as unknown as WindowsLifecycleBrokerClient
      const application = await buildApplication(config, {
        lifecycleBrokerClient: broker,
        hostMutationCoordinator: { async runExclusive(request, operation) {
          requests.push(request)
          if (mode === 'lease-busy') throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_BUSY')
          const result = await operation({ signal: new AbortController().signal,
            assertActive() {}, toPowerShellBorrowArguments: () => [] })
          if (result.kind === 'throw') throw result.error
          return result.value
        } }
      })
      try {
        const login = await application.app.inject({ method: 'POST', url: '/api/v1/auth/login',
          headers: { origin: config.publicOrigin }, payload: { password: 'fictional-configuration-password' } })
        expect(login.statusCode).toBe(200)
        const cookies = { dyson_session: login.cookies[0]!.value }
        const current = await application.app.inject({ method: 'GET', url: '/api/v1/configuration', cookies })
        expect(current.json().data.execution).toMatchObject({ enabled: mode !== 'disabled', requiresStopped: true })
        const requestId = randomUUID()
        const payload = { requestId, confirmation: 'APPLY_CONFIG',
          expectedRevision: current.json().data.revision, changes: [{ id: 'nebula.auto-pause', value: false }] }
        const result = await application.app.inject({ method: 'POST', url: '/api/v1/configuration/apply', cookies,
          headers: { origin: config.publicOrigin }, payload })
        if (mode === 'stopped') {
          expect(result.statusCode, result.body).toBe(200)
          expect(result.json().data).toMatchObject({ transactionId: requestId, status: 'applied' })
          expect(await readFile(file, 'utf8')).toContain('AutoPauseEnabled = false')
          expect(proofs).toBeGreaterThanOrEqual(3)
          const originalProofs = proofs
          await writeFile(file, `${original}# later administrator edit\n`)
          const replay = await application.app.inject({ method: 'POST', url: '/api/v1/configuration/apply', cookies,
            headers: { origin: config.publicOrigin }, payload })
          expect(replay.statusCode, replay.body).toBe(200)
          expect(replay.json()).toEqual(result.json())
          const conflict = await application.app.inject({ method: 'POST', url: '/api/v1/configuration/apply', cookies,
            headers: { origin: config.publicOrigin }, payload: { ...payload, changes: [{ id: 'nebula.auto-pause', value: true }] } })
          expect(conflict.statusCode, conflict.body).toBe(409)
          expect(conflict.json().error.code).toBe('CONFIG_IDEMPOTENCY_CONFLICT')
          expect(await readFile(file, 'utf8')).toBe(`${original}# later administrator edit\n`)
          expect(proofs).toBe(originalProofs)
        } else {
          expect(result.statusCode).toBe(mode === 'disabled' ? 423 : 503)
          expect(await readFile(file, 'utf8')).toBe(original)
        }
        expect(requests).toEqual(Array.from({ length: mode === 'disabled' ? 0 : mode === 'stopped' ? 3 : 1 },
          () => ({ operation: 'game-config-apply', requestId })))
        if (mode === 'disabled' || mode === 'lease-busy') expect(proofs).toBe(0)
      } finally {
        await application.close()
        if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture cleanup')
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

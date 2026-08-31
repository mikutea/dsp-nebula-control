import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HostMutationLeaseError,
  HostMutationLeaseManager,
  type HostMutationBrokerProcess,
  type HostMutationBrokerSpawner
} from './lease.js'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const scriptRoot = path.join(repositoryRoot, 'scripts', 'windows')
const brokerScript = path.join(scriptRoot, 'Invoke-DysonHostMutationLeaseBroker.ps1')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('host mutation lease broker client', () => {
  it('bounds broker startup time and never reflects process context', async () => {
    const fixture = await createFixture('timeout')
    const fake = createFakeSpawner('timeout')
    const manager = new HostMutationLeaseManager({
      scriptRoot,
      startupTimeoutMs: 30,
      maximumOutputBytes: 256,
      spawnBroker: fake.spawn
    })

    const failure = await manager.runExclusive(request(fixture.dataRoot, 'timeout'), async () => undefined)
      .then(() => null, (error: unknown) => error)

    expect(failure).toBeInstanceOf(HostMutationLeaseError)
    expect(failure).toMatchObject({ code: 'DYSON_HOST_MUTATION_LEASE_BROKER_TIMEOUT' })
    expect(String(failure)).not.toContain(fixture.root)
    expect(fake.calls()).toBe(1)
  })

  it('enforces a combined broker output bound without returning broker text', async () => {
    const fixture = await createFixture('output')
    const fake = createFakeSpawner('oversized')
    const manager = new HostMutationLeaseManager({
      scriptRoot,
      startupTimeoutMs: 1_000,
      maximumOutputBytes: 256,
      spawnBroker: fake.spawn
    })

    const failure = await manager.runExclusive(request(fixture.dataRoot, 'output'), async () => undefined)
      .then(() => null, (error: unknown) => error)

    expect(failure).toBeInstanceOf(HostMutationLeaseError)
    expect(failure).toMatchObject({ code: 'DYSON_HOST_MUTATION_LEASE_BROKER_OUTPUT_LIMIT' })
    expect(String(failure)).not.toContain('private-broker-output')
  })

  it('rejects malformed output using only a stable error code', async () => {
    const fixture = await createFixture('malformed')
    const fake = createFakeSpawner('malformed')
    const manager = new HostMutationLeaseManager({ scriptRoot, spawnBroker: fake.spawn })

    const failure = await manager.runExclusive(request(fixture.dataRoot, 'malformed'), async () => undefined)
      .then(() => null, (error: unknown) => error)

    expect(failure).toBeInstanceOf(HostMutationLeaseError)
    expect(failure).toMatchObject({ code: 'DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID' })
    expect((failure as Error).message).toBe('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID')
    expect(String(failure)).not.toMatch(/private|token/i)
  })

  it('passes only an exact paired recovery binding and labels the resulting scope', async () => {
    const fixture = await createFixture('recovery')
    const fake = createFakeSpawner('ready')
    const manager = new HostMutationLeaseManager({ scriptRoot, spawnBroker: fake.spawn })
    const priorInstanceId = '11111111-2222-4333-8444-555555555555'
    const priorRecordDigest = 'a'.repeat(64)

    await manager.runExclusive({
      ...request(fixture.dataRoot, 'recovery'),
      recovery: { priorInstanceId, priorRecordDigest }
    }, async (lease) => {
      expect(lease.leaseKind).toBe('recovery')
    })

    expect(fake.arguments()).toEqual(expect.arrayContaining([
      '-RecoveryPriorInstanceId', priorInstanceId,
      '-RecoveryPriorRecordDigest', priorRecordDigest
    ]))
    await expect(manager.runExclusive({
      ...request(fixture.dataRoot, 'invalid-recovery'),
      recovery: { priorInstanceId, priorRecordDigest: 'short' }
    }, async () => undefined)).rejects.toMatchObject({
      code: 'DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID'
    })
    expect(fake.calls()).toBe(1)
  })

  it('aborts cooperative work as soon as the holder broker exits unexpectedly', async () => {
    const fixture = await createFixture('broker-exit')
    const fake = createFakeSpawner('ready-then-exit')
    const manager = new HostMutationLeaseManager({ scriptRoot, spawnBroker: fake.spawn })

    await expect(manager.runExclusive(request(fixture.dataRoot, 'broker-exit'), async (lease) => {
      await new Promise<void>((resolve) => {
        if (lease.signal.aborted) resolve()
        else lease.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      expect(lease.signal.aborted).toBe(true)
      expect(lease.signal.reason).toMatchObject({
        code: 'DYSON_HOST_MUTATION_LEASE_BROKER_EXITED'
      })
      expect(() => lease.assertActive()).toThrowError(expect.objectContaining({
        code: 'DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE'
      }))
    })).rejects.toMatchObject({ code: 'DYSON_HOST_MUTATION_LEASE_BROKER_EXITED' })
  })
})

describe.runIf(process.platform === 'win32')('Windows host mutation lease interoperability', () => {
  it('persists a real broker abandonment and preserves the original action failure', async () => {
    const fixture = await createFixture('action-failure')
    const manager = new HostMutationLeaseManager({ scriptRoot })
    const actionFailure = new Error('FICTIONAL_ACTION_FAILED')

    const observed = await manager.runExclusive(
      request(fixture.dataRoot, 'action-failure'),
      async () => { throw actionFailure }
    ).then(() => null, (error: unknown) => error)
    expect(observed).toBe(actionFailure)

    const nextMutation = await invokeRealBroker(fixture.dataRoot, 'after-action-failure')
    expect(nextMutation.exitCode).toBe(20)
    expect(JSON.parse(nextMutation.stdout)).toMatchObject({
      protocol: 'DYSON_HOST_MUTATION_BROKER_V1',
      type: 'error',
      code: 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED',
      priorState: 'abandoned'
    })
    expect(nextMutation.stderr).toBe('')
    expect(nextMutation.stdout).not.toContain(fixture.root)
  }, 30_000)

  it('uses one real PowerShell holder for ALS nesting, rejects another root chain, and invalidates stale scope',
    async () => {
      const fixture = await createFixture('real')
      const manager = new HostMutationLeaseManager({
        scriptRoot,
        startupTimeoutMs: 15_000,
        releaseTimeoutMs: 10_000
      })
      const otherManager = new HostMutationLeaseManager({ scriptRoot })
      const acquired = deferred<void>()
      const release = deferred<void>()
      let capturedLease: Parameters<Parameters<typeof manager.runExclusive>[1]>[0] | undefined
      let inScopeToken = ''

      const first = manager.runExclusive(request(fixture.dataRoot, 'outer'), async (outer) => {
        capturedLease = outer
        inScopeToken = outer.token
        expect(outer.borrowed).toBe(false)
        await manager.runExclusive(request(fixture.dataRoot, 'nested'), async (nested) => {
          expect(nested.borrowed).toBe(true)
          expect(nested.instanceId).toBe(outer.instanceId)
          expect(nested.token).toBe(outer.token)
          expect(manager.currentLease(fixture.dataRoot).instanceId).toBe(outer.instanceId)
        })

        const contender = await invokeRealBroker(fixture.dataRoot, 'ps-contender')
        expect(contender.exitCode).toBe(20)
        expect(JSON.parse(contender.stdout)).toMatchObject({
          protocol: 'DYSON_HOST_MUTATION_BROKER_V1',
          type: 'error',
          code: 'DYSON_HOST_MUTATION_LEASE_BUSY'
        })
        expect(contender.stderr).toBe('')
        expect(contender.stdout).not.toContain(fixture.root)
        expect(contender.stdout).not.toContain(inScopeToken)
        acquired.resolve()
        await release.promise
      })

      try {
        await acquired.promise
        await expect(otherManager.runExclusive(
          request(fixture.dataRoot, 'other-root-chain'), async () => undefined
        )).rejects.toMatchObject({ code: 'DYSON_HOST_MUTATION_LEASE_BUSY' })
      } finally {
        release.resolve()
      }
      await first
      expect(capturedLease).toBeDefined()
      expect(() => capturedLease?.assertActive()).toThrowError(expect.objectContaining({
        code: 'DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE'
      }))
      expect(() => capturedLease?.token).toThrowError(expect.objectContaining({
        code: 'DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE'
      }))
      expect(() => manager.currentLease()).toThrowError(expect.objectContaining({
        code: 'DYSON_HOST_MUTATION_LEASE_SCOPE_UNAVAILABLE'
      }))
    }, 40_000)
})

interface Fixture {
  root: string
  dataRoot: string
}

async function createFixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `dyson-host-lease-${label}-`))
  temporaryRoots.push(root)
  const dataRoot = path.join(root, 'data')
  await mkdir(dataRoot)
  return { root, dataRoot }
}

function request(dataRoot: string, suffix: string) {
  return {
    dataRoot,
    owner: 'node-selftest',
    operation: 'lease-test',
    requestId: `request-${suffix}`,
    acquireTimeoutMs: 100
  }
}

type FakeMode = 'timeout' | 'oversized' | 'malformed' | 'ready' | 'ready-then-exit'

function createFakeSpawner(mode: FakeMode): {
  spawn: HostMutationBrokerSpawner
  calls: () => number
  arguments: () => readonly string[]
} {
  let callCount = 0
  let lastArguments: readonly string[] = []
  return {
    spawn: (_executable, arguments_) => {
      callCount += 1
      lastArguments = [...arguments_]
      return new FakeBrokerProcess(mode)
    },
    calls: () => callCount,
    arguments: () => lastArguments
  }
}

class FakeBrokerProcess extends EventEmitter implements HostMutationBrokerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  #exited = false

  constructor(mode: FakeMode) {
    super()
    this.stdin.on('data', (chunk: Buffer | string) => {
      if (String(chunk).includes('RELEASE\n')) this.#exit(0, null)
      else if (String(chunk).includes('ABANDON\n')) this.#exit(22, null)
    })
    queueMicrotask(() => {
      if (mode === 'oversized') {
        this.stdout.write(Buffer.from('private-broker-output'.repeat(20), 'utf8'))
      } else if (mode === 'malformed') {
        this.stdout.write('{"private":"token-value"}\n')
      } else if (mode === 'ready' || mode === 'ready-then-exit') {
        this.stdout.write(JSON.stringify({
          protocol: 'DYSON_HOST_MUTATION_BROKER_V1',
          type: 'ready',
          dataRootIdentity: `sha256:${'b'.repeat(64)}`,
          instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          token: 'A'.repeat(43)
        }) + '\n')
        if (mode === 'ready-then-exit') {
          setTimeout(() => this.#exit(null, 'SIGKILL'), 10)
        }
      }
    })
  }

  kill(): boolean {
    this.#exit(null, 'SIGTERM')
    return true
  }

  #exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return
    this.#exited = true
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    queueMicrotask(() => this.emit('exit', code, signal))
  }
}

async function invokeRealBroker(dataRoot: string, requestId: string): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', brokerScript,
    '-DataRoot', dataRoot,
    '-Owner', 'node-interop',
    '-Operation', 'contender',
    '-RequestId', requestId,
    '-OwnerPid', String(process.pid),
    '-TimeoutMilliseconds', '100'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let bytes = 0
  const collect = (chunk: Buffer | string, target: 'stdout' | 'stderr') => {
    const text = String(chunk)
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > 4_096) child.kill()
    if (target === 'stdout') stdout += text
    else stderr += text
  }
  child.stdout.on('data', (chunk: Buffer | string) => collect(chunk, 'stdout'))
  child.stderr.on('data', (chunk: Buffer | string) => collect(chunk, 'stderr'))

  const result = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('REAL_BROKER_TIMEOUT'))
    }, 10_000)
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('REAL_BROKER_START_FAILED'))
    })
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolve({ exitCode })
    })
  })
  expect(bytes).toBeLessThanOrEqual(4_096)
  return { exitCode: result.exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolve_) => { resolve = resolve_ })
  return { promise, resolve }
}

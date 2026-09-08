import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LifecycleHostMutationScope } from '../domain.js'
import {
  FixedWindowsLifecycleBrokerClient,
  WindowsLifecycleBrokerClientError,
  lifecycleBrokerSubmitScriptName,
  type LifecycleBrokerScriptName,
  type WindowsLifecycleBrokerPowerShellRunner
} from './windows-lifecycle-broker.js'

const gamePort = 8469
const dataRoot = path.join(os.tmpdir(), 'fictional-dyson-control', 'data')
const brokerRoot = path.join(dataRoot, 'lifecycle-broker')
const profileFile = path.join(brokerRoot, 'broker-profile.json')
const leaseInstanceId = '10000000-0000-4000-8000-000000000001'
const leaseBorrowFixture = 'A'.repeat(43)
const requestFingerprint = 'c'.repeat(64)

describe('fixed Windows lifecycle broker client', () => {
  it('validates optional process telemetry and rejects mismatched identity or generation ordering', async () => {
    const sample = { processId: 2202, startedAtUnixMs: 1_000, sampledAtUnixMs: 2_000,
      processCoresUsed: 0.5, workingSetGiB: 1, privateMemoryGiB: 2, threadCount: 3 }
    for (const patch of [null, { processId: 2203 }, { startedAtUnixMs: 3_000 },
      { threadCount: -1 }, { privateMemoryGiB: null }]) {
      const harness = createHarness()
      harness.runner.respond = (call) => {
        const result = resultFor(call)
        result.receipt.evidence = { ...statusEvidence(), processTelemetry: { ...sample, ...patch } }
        return JSON.stringify(result)
      }
      const read = harness.client.status({ signal: new AbortController().signal })
      if (patch === null) expect((await read).processTelemetry).toEqual(sample)
      else await expect(read).rejects.toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
    }
  })
  it('uses only the fixed submit script and derives stable purpose-bound request IDs', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const outerRequestId = id(41)

    await harness.client.preflight({ action: 'start', outerRequestId, signal })
    await harness.client.preflight({ action: 'start', outerRequestId, signal })
    await harness.client.verify({ expected: 'running', outerRequestId, signal })

    const expectedPreflightId = expectedBrokerRequestId(outerRequestId, 'preflight:start')
    const expectedVerifyId = expectedBrokerRequestId(outerRequestId, 'verify:running')
    expect(harness.runner.calls).toEqual([
      {
        scriptName: lifecycleBrokerSubmitScriptName,
        arguments_: commonArguments(expectedPreflightId, 'LifecyclePreflight', [
          '-Action', 'start'
        ]),
        signal
      },
      {
        scriptName: lifecycleBrokerSubmitScriptName,
        arguments_: commonArguments(expectedPreflightId, 'LifecyclePreflight', [
          '-Action', 'start'
        ]),
        signal
      },
      {
        scriptName: lifecycleBrokerSubmitScriptName,
        arguments_: commonArguments(expectedVerifyId, 'LifecycleVerify', [
          '-Expected', 'running'
        ]),
        signal
      }
    ])
    expect(expectedPreflightId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
    expect(expectedVerifyId).not.toBe(expectedPreflightId)
  })

  it('accepts the exact idempotent replay envelope without mutating the durable receipt', async () => {
    const harness = createHarness()
    harness.runner.respond = (call) => JSON.stringify(resultFor(call, {
      topLevelReused: harness.runner.calls.length > 1
    }))
    const signal = new AbortController().signal
    const input = { action: 'restart' as const, outerRequestId: id(42), signal }

    const first = await harness.client.preflight(input)
    const replay = await harness.client.preflight(input)

    expect(replay).toEqual(first)
    expect(harness.runner.calls).toHaveLength(2)
    expect(argument(harness.runner.calls[0]!.arguments_, '-BrokerRequestId')).toBe(
      argument(harness.runner.calls[1]!.arguments_, '-BrokerRequestId')
    )
  })

  it('rejects a rewritten receipt that falsely marks itself reused', async () => {
    const harness = createHarness()
    harness.runner.respond = (call) => JSON.stringify(resultFor(call, {
      topLevelReused: true,
      receiptReused: true
    }))

    const error = await captureError(harness.client.preflight({
      action: 'save',
      outerRequestId: id(43),
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID',
      message: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID'
    })
  })

  it('passes the exact borrowed lease and fixed dispatch arguments across the SYSTEM boundary', async () => {
    const harness = createHarness()
    const active = activeScope()
    const signal = new AbortController().signal
    const outerRequestId = id(44)

    const result = await harness.client.dispatch({
      operation: 'start',
      outerRequestId,
      hostMutation: active.scope,
      signal
    })

    const brokerRequestId = expectedBrokerRequestId(outerRequestId, 'dispatch:start')
    expect(result).toMatchObject({
      operation: 'start',
      dispatched: true,
      taskName: 'Dyson-Nebula-Server',
      taskPath: '\\'
    })
    expect(harness.runner.calls).toEqual([{
      scriptName: 'Submit-DysonLifecycleBrokerRequest.ps1',
      arguments_: commonArguments(brokerRequestId, 'LifecycleDispatch', [
        '-Operation', 'start',
        '-DataRoot', dataRoot,
        '-LeaseInstanceId', leaseInstanceId,
        '-LeaseToken', leaseBorrowFixture,
        '-Confirm:$false'
      ]),
      signal
    }])
    expect(active.assertions()).toBe(2)
    expect(harness.runner.calls[0]!.arguments_).not.toContain('-Backend')
    expect(harness.runner.calls[0]!.arguments_).not.toContain('-Command')
    expect(harness.runner.calls[0]!.arguments_).not.toContain('-ScriptName')
  })

  it.each([
    ['wrong data root', ['-DataRoot', path.join(os.tmpdir(), 'fictional-other-data'), '-LeaseInstanceId', leaseInstanceId, '-LeaseToken', leaseBorrowFixture]],
    ['wrong order', ['-LeaseInstanceId', leaseInstanceId, '-DataRoot', dataRoot, '-LeaseToken', leaseBorrowFixture]],
    ['extra argument', ['-DataRoot', dataRoot, '-LeaseInstanceId', leaseInstanceId, '-LeaseToken', leaseBorrowFixture, '-Command', 'whoami']],
    ['invalid instance id', ['-DataRoot', dataRoot, '-LeaseInstanceId', 'not-a-guid', '-LeaseToken', leaseBorrowFixture]],
    ['invalid token', ['-DataRoot', dataRoot, '-LeaseInstanceId', leaseInstanceId, '-LeaseToken', 'short-token']]
  ] as const)('rejects a non-exact lease binding: %s', async (_label, borrowArguments) => {
    const harness = createHarness()
    const active = activeScope([...borrowArguments])

    const error = await captureError(harness.client.dispatch({
      operation: 'graceful-stop',
      outerRequestId: id(45),
      hostMutation: active.scope,
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_LIFECYCLE_BROKER_BORROW_BINDING_INVALID',
      message: 'WINDOWS_LIFECYCLE_BROKER_BORROW_BINDING_INVALID'
    })
    expect(harness.runner.calls).toEqual([])
  })

  it('returns strict preflight and status evidence without dispatching a task', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal

    const preflight = await harness.client.preflight({
      action: 'start',
      outerRequestId: id(46),
      signal
    })
    const status = await harness.client.status({ signal })

    expect(preflight).toMatchObject({
      action: 'start',
      allowed: true,
      blockers: [],
      dispatch: { attempted: false, taskName: null }
    })
    expect(status).toMatchObject({
      lifecycleState: 'running_verified',
      runtime: { lifecycleState: 'running_verified', port: { port: gamePort } }
    })
    expect(harness.runner.calls.map((call) => argument(call.arguments_, '-Capability'))).toEqual([
      'LifecyclePreflight', 'LifecycleStatus'
    ])
    expect(harness.runner.calls.flatMap((call) => call.arguments_)).not.toContain('-LeaseToken')
    expect(harness.runner.calls.flatMap((call) => call.arguments_)).not.toContain('-Operation')
  })

  it('accepts a blocked preflight as evidence but never reports it as allowed', async () => {
    const harness = createHarness()
    harness.runner.respond = (call) => JSON.stringify(resultFor(call, {
      status: 'blocked',
      evidence: preflightEvidence('start', false, ['interactive_session_missing'])
    }))

    const result = await harness.client.preflight({
      action: 'start',
      outerRequestId: id(47),
      signal: new AbortController().signal
    })

    expect(result.allowed).toBe(false)
    expect(result.blockers).toEqual(['interactive_session_missing'])
  })

  it.each([
    ['action binding', (evidence: Record<string, unknown>) => { evidence.action = 'save' }],
    ['game-port binding', (evidence: Record<string, unknown>) => {
      const runtime = evidence.runtime as ReturnType<typeof stoppedRuntime>
      runtime.port.port = gamePort + 1
    }],
    ['allowed runtime state', (evidence: Record<string, unknown>) => {
      evidence.runtime = runningRuntime()
    }]
  ] as const)('rejects preflight evidence that violates the fixed %s', async (_label, mutate) => {
    const harness = createHarness()
    harness.runner.respond = (call) => {
      const evidence = preflightEvidence('start')
      mutate(evidence)
      return JSON.stringify(resultFor(call, { evidence }))
    }

    const error = await captureError(harness.client.preflight({
      action: 'start', outerRequestId: id(471), signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
  })

  it.each([
    ['matched=false succeeded receipt', {
      expected: 'running', matched: false, blockers: [], runtime: runningRuntime()
    }],
    ['matched=true wrong runtime state', {
      expected: 'running', matched: true, blockers: [], runtime: stoppedRuntime()
    }],
    ['matched=true wrong game port', (() => {
      const runtime = runningRuntime()
      runtime.port.port = gamePort + 1
      return { expected: 'running', matched: true, blockers: [], runtime }
    })()]
  ] as const)('rejects a semantically inconsistent verify result: %s', async (_label, evidence) => {
    const harness = createHarness()
    harness.runner.respond = (call) => JSON.stringify(resultFor(call, { evidence }))

    const error = await captureError(harness.client.verify({
      expected: 'running', outerRequestId: id(472), signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
  })

  it('surfaces a blocked dispatch with only the bounded broker blockers', async () => {
    const harness = createHarness()
    harness.runner.respond = (call) => JSON.stringify(resultFor(call, {
      status: 'blocked',
      evidence: {
        operation: 'graceful-stop',
        dispatched: false,
        blockers: ['server_not_running'],
        taskName: 'Dyson-Nebula-Stop',
        runtime: stoppedRuntime()
      }
    }))

    const error = await captureError(harness.client.dispatch({
      operation: 'graceful-stop',
      outerRequestId: id(48),
      hostMutation: activeScope().scope,
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_LIFECYCLE_BROKER_BLOCKED',
      brokerErrorCode: null,
      blockers: ['server_not_running']
    })
  })

  it.each([
    ['wrong fixed task', {
      operation: 'start', dispatched: true, blockers: [], taskName: 'Dyson-Nebula-Stop',
      taskPath: '\\', readyVerified: true
    }],
    ['readiness not verified', {
      operation: 'start', dispatched: true, blockers: [], taskName: 'Dyson-Nebula-Server',
      taskPath: '\\', readyVerified: false
    }],
    ['false recovered success', {
      operation: 'start', dispatched: false, recovered: false, blockers: [], runtime: runningRuntime()
    }]
  ] as const)('rejects semantically impossible dispatch success: %s', async (_label, evidence) => {
    const harness = createHarness()
    harness.runner.respond = (call) => JSON.stringify(resultFor(call, { evidence }))

    const error = await captureError(harness.client.dispatch({
      operation: 'start', outerRequestId: id(481), hostMutation: activeScope().scope,
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
  })

  it('rejects recovered dispatch evidence for a different configured game port', async () => {
    const harness = createHarness()
    harness.runner.respond = (call) => {
      const runtime = runningRuntime()
      runtime.port.port = gamePort + 1
      return JSON.stringify(resultFor(call, {
        evidence: { operation: 'start', dispatched: false, recovered: true, blockers: [], runtime }
      }))
    }

    const error = await captureError(harness.client.dispatch({
      operation: 'start', outerRequestId: id(482), hostMutation: activeScope().scope,
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
  })

  it('surfaces a fixed broker failure code and bounded blockers', async () => {
    const harness = createHarness()
    harness.runner.respond = (call) => JSON.stringify(resultFor(call, {
      status: 'failed',
      errorCode: 'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID',
      evidence: { dispatched: false, blockers: ['recovery_required'] }
    }))

    const error = await captureError(harness.client.dispatch({
      operation: 'rollback-start',
      outerRequestId: id(49),
      hostMutation: activeScope().scope,
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_LIFECYCLE_BROKER_FAILED',
      brokerErrorCode: 'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID',
      blockers: ['recovery_required']
    })
  })

  it.each([
    ['non-JSON output', () => 'not-json'],
    ['unexpected envelope field', (call: RunnerCall) => {
      const result = resultFor(call) as TestResult & { command?: string }
      result.command = 'whoami'
      return JSON.stringify(result)
    }],
    ['mismatched broker request id', (call: RunnerCall) => {
      const result = resultFor(call)
      result.brokerRequestId = id(999)
      return JSON.stringify(result)
    }],
    ['receipt completed before creation', (call: RunnerCall) => {
      const result = resultFor(call)
      result.receipt.createdAt = '2031-02-03T04:05:07.000Z'
      result.receipt.completedAt = '2031-02-03T04:05:06.000Z'
      return JSON.stringify(result)
    }],
    ['runtime evidence violates strict shape', (call: RunnerCall) => {
      const result = resultFor(call)
      result.receipt.evidence = {
        ...statusEvidence(),
        lifecycleState: 'stopped_verified'
      }
      return JSON.stringify(result)
    }]
  ] as const)('rejects malformed broker output: %s', async (_label, output) => {
    const harness = createHarness()
    harness.runner.respond = (call) => output(call)

    const error = await captureError(harness.client.status({
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
  })

  it('rejects output over the UTF-8 byte ceiling before JSON parsing', async () => {
    const harness = createHarness()
    harness.runner.respond = () => JSON.stringify({ padding: '界'.repeat(50_000) })

    const error = await captureError(harness.client.status({
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
  })

  it('rejects a status receipt whose observed game port drifts from the fixed binding', async () => {
    const harness = createHarness()
    harness.runner.respond = (call) => {
      const evidence = statusEvidence()
      evidence.runtime.port.port = gamePort + 1
      return JSON.stringify(resultFor(call, { evidence }))
    }

    const error = await captureError(harness.client.status({
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID' })
  })

  it('fails closed before invoking PowerShell when the request is already cancelled', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    controller.abort()

    const error = await captureError(harness.client.status({ signal: controller.signal }))

    expect(error).toMatchObject({ code: 'WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID' })
    expect(harness.runner.calls).toEqual([])
  })

  it('rejects client construction outside the fixed lifecycle-broker profile location', () => {
    const runner = new RecordingRunner()

    expect(() => new FixedWindowsLifecycleBrokerClient({
      profileFile: path.join(dataRoot, 'other-broker', 'broker-profile.json'),
      dataRoot,
      gamePort,
      runner
    })).toThrowError(expect.objectContaining({
      code: 'WINDOWS_LIFECYCLE_BROKER_OPTIONS_INVALID'
    }))
    expect(() => new FixedWindowsLifecycleBrokerClient({
      profileFile,
      dataRoot,
      gamePort,
      timeoutSeconds: 301,
      runner
    })).toThrowError(expect.objectContaining({
      code: 'WINDOWS_LIFECYCLE_BROKER_OPTIONS_INVALID'
    }))
  })

  it('returns code-only client errors', async () => {
    const harness = createHarness()
    harness.runner.respond = () => '{bad-json'

    const error = await captureError(harness.client.status({
      signal: new AbortController().signal
    }))

    expect(error).toBeInstanceOf(WindowsLifecycleBrokerClientError)
    expect(error).toMatchObject({
      code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID',
      message: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID'
    })
    expect(JSON.stringify(error)).not.toContain(dataRoot)
  })
})

interface RunnerCall {
  scriptName: LifecycleBrokerScriptName
  arguments_: string[]
  signal: AbortSignal
}

class RecordingRunner implements WindowsLifecycleBrokerPowerShellRunner {
  readonly calls: RunnerCall[] = []
  respond: (call: RunnerCall) => string = (call) => JSON.stringify(resultFor(call))

  async run(
    scriptName: LifecycleBrokerScriptName,
    scriptArguments: string[],
    signal: AbortSignal
  ): Promise<string> {
    const call = { scriptName, arguments_: [...scriptArguments], signal }
    this.calls.push(call)
    return this.respond(call)
  }
}

interface TestReceipt {
  protocol: string
  schemaVersion: number
  brokerRequestId: string
  requestFingerprint: string
  capability: string
  status: 'succeeded' | 'blocked' | 'failed'
  errorCode: string | null
  evidence: unknown
  createdAt: string
  completedAt: string
  reused: boolean
}

interface TestResult {
  protocol: string
  schemaVersion: number
  brokerRequestId: string
  capability: string
  reused: boolean
  receipt: TestReceipt
}

interface ResultOverrides {
  status?: TestReceipt['status']
  errorCode?: string | null
  evidence?: unknown
  topLevelReused?: boolean
  receiptReused?: boolean
}

function createHarness(): {
  runner: RecordingRunner
  client: FixedWindowsLifecycleBrokerClient
} {
  const runner = new RecordingRunner()
  const client = new FixedWindowsLifecycleBrokerClient({
    profileFile,
    dataRoot,
    gamePort,
    timeoutSeconds: 37,
    runner
  })
  return { runner, client }
}

function resultFor(call: RunnerCall, overrides: ResultOverrides = {}): TestResult {
  const brokerRequestId = argument(call.arguments_, '-BrokerRequestId')
  const capability = argument(call.arguments_, '-Capability')
  const status = overrides.status ?? 'succeeded'
  const errorCode = overrides.errorCode === undefined ? null : overrides.errorCode
  return {
    protocol: 'DYSON_CONTROL_LIFECYCLE_BROKER_RESULT_V1',
    schemaVersion: 1,
    brokerRequestId,
    capability,
    reused: overrides.topLevelReused ?? false,
    receipt: {
      protocol: 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_V1',
      schemaVersion: 1,
      brokerRequestId,
      requestFingerprint,
      capability,
      status,
      errorCode,
      evidence: overrides.evidence ?? defaultEvidence(call),
      createdAt: '2031-02-03T04:05:06.000Z',
      completedAt: '2031-02-03T04:05:07.000Z',
      reused: overrides.receiptReused ?? false
    }
  }
}

function defaultEvidence(call: RunnerCall): unknown {
  const capability = argument(call.arguments_, '-Capability')
  switch (capability) {
    case 'LifecyclePreflight':
      return preflightEvidence(argument(call.arguments_, '-Action') as 'start' | 'save' | 'graceful-stop' | 'restart')
    case 'LifecycleDispatch': {
      const operation = argument(call.arguments_, '-Operation') as 'start' | 'graceful-stop' | 'rollback-start'
      return {
        operation,
        dispatched: true,
        blockers: [],
        taskName: operation === 'graceful-stop' ? 'Dyson-Nebula-Stop' : 'Dyson-Nebula-Server',
        taskPath: '\\',
        readyVerified: true
      }
    }
    case 'LifecycleVerify': {
      const expected = argument(call.arguments_, '-Expected') as 'running' | 'stopped'
      return {
        expected,
        matched: true,
        blockers: [],
        runtime: expected === 'running' ? runningRuntime() : stoppedRuntime()
      }
    }
    case 'LifecycleStatus':
      return statusEvidence()
    default:
      return null
  }
}

function preflightEvidence(
  action: 'start' | 'save' | 'graceful-stop' | 'restart',
  allowed = true,
  blockers: string[] = []
): Record<string, unknown> {
  return {
    action,
    allowed,
    blockers,
    task: taskEvidence(),
    runtime: action === 'start' ? stoppedRuntime() : runningRuntime(),
    dispatch: { attempted: false, taskName: null }
  }
}

function statusEvidence(): {
  lifecycleState: 'running_verified'
  task: ReturnType<typeof taskEvidence>
  runtime: ReturnType<typeof runningRuntime>
} {
  return {
    lifecycleState: 'running_verified',
    task: taskEvidence(),
    runtime: runningRuntime()
  }
}

function taskEvidence(): {
  valid: true
  server: { name: 'Dyson-Nebula-Server'; path: '\\'; state: string }
  stop: { name: 'Dyson-Nebula-Stop'; path: '\\'; state: string }
} {
  return {
    valid: true,
    server: { name: 'Dyson-Nebula-Server', path: '\\', state: 'Ready' },
    stop: { name: 'Dyson-Nebula-Stop', path: '\\', state: 'Ready' }
  }
}

function runningRuntime() {
  return {
    lifecycleState: 'running_verified' as const,
    session: { status: 'verified' as const, id: 7, count: 1 },
    steam: { status: 'verified' as const, pid: 1101, sessionId: 7 },
    process: {
      status: 'verified' as const,
      pid: 2202,
      owner: '.\\FictionalDyson',
      sessionId: 7
    },
    port: { port: gamePort, listenerCount: 1 },
    pidFile: { present: true, valid: true }
  }
}

function stoppedRuntime() {
  return {
    lifecycleState: 'stopped_verified' as const,
    session: { status: 'verified' as const, id: 7, count: 1 },
    steam: { status: 'verified' as const, pid: 1101, sessionId: 7 },
    process: {
      status: 'absent' as const,
      pid: null,
      owner: null,
      sessionId: null
    },
    port: { port: gamePort, listenerCount: 0 },
    pidFile: { present: false, valid: false }
  }
}

function commonArguments(
  brokerRequestId: string,
  capability: string,
  capabilityArguments: string[]
): string[] {
  return [
    '-BrokerRoot', brokerRoot,
    '-ProfileFile', profileFile,
    '-BrokerRequestId', brokerRequestId,
    '-Capability', capability,
    ...capabilityArguments,
    '-TimeoutSeconds', '37'
  ]
}

function activeScope(
  borrowArguments: readonly string[] = [
    '-DataRoot', dataRoot,
    '-LeaseInstanceId', leaseInstanceId,
    '-LeaseToken', leaseBorrowFixture
  ]
): { scope: LifecycleHostMutationScope; assertions: () => number } {
  let assertionCount = 0
  return {
    scope: {
      assertActive(): void { assertionCount += 1 },
      toPowerShellBorrowArguments(): readonly string[] { return borrowArguments }
    },
    assertions: () => assertionCount
  }
}

function argument(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name)
  if (index < 0 || index + 1 >= arguments_.length) throw new Error(`missing test argument ${name}`)
  return arguments_[index + 1]!
}

function expectedBrokerRequestId(outerRequestId: string, purpose: string): string {
  const digest = createHash('sha256').update(JSON.stringify({
    outerRequestId: outerRequestId.toLowerCase(),
    protocol: 'dyson-control-lifecycle-broker-request-v1',
    purpose
  })).digest('hex')
  const versioned = `${digest.slice(0, 12)}5${digest.slice(13, 16)}`
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)
  const normalized = `${versioned}${variant}${digest.slice(17, 32)}`
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-` +
    `${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

async function captureError(promise: Promise<unknown>): Promise<WindowsLifecycleBrokerClientError> {
  try {
    await promise
  } catch (error) {
    return error as WindowsLifecycleBrokerClientError
  }
  throw new Error('expected a lifecycle broker client error')
}

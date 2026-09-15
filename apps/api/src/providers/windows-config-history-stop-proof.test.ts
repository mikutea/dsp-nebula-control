import { describe, expect, it } from 'vitest'
import {
  WindowsLifecycleBrokerClientError,
  type WindowsLifecycleBrokerClient
} from './windows-lifecycle-broker.js'
import {
  WindowsConfigHistoryStopProofAuthorizer,
  WindowsConfigHistoryStopProofError
} from './windows-config-history-stop-proof.js'

describe('Windows game configuration history stop-proof authorizer', () => {
  it('issues after broker verification and uses a fresh outer request UUID for every proof', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const issue = authorizer.issue
    const validate = authorizer.validate

    const token = await issue(restoreIssueContext)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await validate(validationContext(token, 'prepare'))).toBe(true)
    expect(await validate(validationContext(token, 'publish'))).toBe(true)
    expect(brokerClient.calls).toHaveLength(3)
    expect(brokerClient.calls.map(({ expected, aborted }) => ({ expected, aborted }))).toEqual([
      { expected: 'stopped', aborted: false },
      { expected: 'stopped', aborted: false },
      { expected: 'stopped', aborted: false }
    ])
    const outerRequestIds = brokerClient.calls.map((call) => call.outerRequestId)
    expect(outerRequestIds).toEqual(outerRequestIds.map((requestId) =>
      expect.stringMatching(uuidV4Pattern)
    ))
    expect(new Set(outerRequestIds)).toHaveLength(3)
    expect(JSON.stringify(authorizer)).not.toContain(token)
  })

  it('never reuses an issuance proof after broker state changes', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const token = await authorizer.issue(restoreIssueContext)
    const issuanceRequestId = brokerClient.calls[0]?.outerRequestId

    brokerClient.result = {
      ...validStoppedEvidence,
      matched: false,
      blockers: ['state_mismatch']
    }
    expect(await authorizer.validate(validationContext(token, 'prepare'))).toBe(false)
    expect(brokerClient.calls).toHaveLength(2)
    expect(brokerClient.calls[1]?.outerRequestId).not.toBe(issuanceRequestId)

    brokerClient.result = validStoppedEvidence
    expect(await authorizer.validate(validationContext(token, 'publish'))).toBe(true)
    expect(new Set(brokerClient.calls.map((call) => call.outerRequestId))).toHaveLength(3)
  })

  it('does not consume a token and binds restore grants to request and snapshot identity', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const token = await authorizer.issue(restoreIssueContext)

    expect(await authorizer.validate(validationContext(token, 'prepare'))).toBe(true)
    expect(await authorizer.validate(validationContext(token, 'prepare'))).toBe(true)
    expect(await authorizer.validate({
      ...validationContext(token, 'publish'),
      requestId: otherRequestId
    })).toBe(false)
    expect(await authorizer.validate({
      ...validationContext(token, 'publish'),
      snapshotId: otherSnapshotId
    })).toBe(false)
    expect(await authorizer.validate(validationContext(token, 'reconcile'))).toBe(false)
    expect(await authorizer.validate({
      ...validationContext('A'.repeat(43), 'publish')
    })).toBe(false)
    expect(brokerClient.calls).toHaveLength(3)
  })

  it('forwards cancellation to broker verification and rejects an already-cancelled validation', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const token = await authorizer.issue(restoreIssueContext)
    const controller = new AbortController()

    expect(await authorizer.validate(
      validationContext(token, 'publish'), controller.signal
    )).toBe(true)
    expect(brokerClient.signals.at(-1)).toBe(controller.signal)

    const callCount = brokerClient.calls.length
    controller.abort('fixture-host-lease-lost')
    expect(await authorizer.validate(
      validationContext(token, 'publish'), controller.signal
    )).toBe(false)
    expect(brokerClient.calls).toHaveLength(callCount)
  })

  it('fails validation closed when cancellation occurs during broker verification', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const token = await authorizer.issue(restoreIssueContext)
    const controller = new AbortController()
    brokerClient.result = ({ signal }: VerifyInput) => {
      controller.abort('fixture-cancelled-in-flight')
      expect(signal).toBe(controller.signal)
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_FAILED', {
        brokerErrorCode: 'DYSON_CONTROL_LIFECYCLE_BROKER_CANCELLED'
      })
    }

    expect(await authorizer.validate(
      validationContext(token, 'publish'), controller.signal
    )).toBe(false)
    expect(brokerClient.calls).toHaveLength(2)
    expect(brokerClient.calls[1]?.outerRequestId).not.toBe(brokerClient.calls[0]?.outerRequestId)
  })

  it('allows one reconcile grant to revalidate multiple bounded journal contexts', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const token = await authorizer.issue({ operation: 'reconcile' })

    expect(await authorizer.validate(validationContext(token, 'reconcile'))).toBe(true)
    expect(await authorizer.validate({
      ...validationContext(token, 'reconcile'),
      requestId: otherRequestId,
      snapshotId: otherSnapshotId
    })).toBe(true)
    expect(await authorizer.validate(validationContext(token, 'prepare'))).toBe(false)
    expect(brokerClient.calls).toHaveLength(3)
  })

  it('expires tokens at the TTL boundary and frees their bounded capacity', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    let now = 10_000
    const authorizer = createAuthorizer(brokerClient, {
      tokenTtlMs: 1_000,
      maximumTokens: 1,
      now: () => now
    })
    const first = await authorizer.issue(restoreIssueContext)

    now = 10_999
    expect(await authorizer.validate(validationContext(first, 'prepare'))).toBe(true)
    now = 11_000
    expect(await authorizer.validate(validationContext(first, 'publish'))).toBe(false)
    const second = await authorizer.issue(restoreIssueContext)
    expect(second).not.toBe(first)
    expect(brokerClient.calls).toHaveLength(3)
  })

  it('rejects issuance at capacity without evicting a live grant', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient, { maximumTokens: 1 })
    const first = await authorizer.issue(restoreIssueContext)

    await expect(authorizer.issue({ operation: 'reconcile' })).rejects.toMatchObject({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CAPACITY_EXCEEDED'
    })
    expect(await authorizer.validate(validationContext(first, 'prepare'))).toBe(true)
    expect(brokerClient.calls).toHaveLength(2)
  })

  it('serializes concurrent issuance so capacity can never be exceeded', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient, { maximumTokens: 1 })
    const results = await Promise.allSettled([
      authorizer.issue(restoreIssueContext),
      authorizer.issue({ operation: 'reconcile' })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CAPACITY_EXCEEDED' }
    })
    expect(brokerClient.calls).toHaveLength(1)
  })

  it.each([
    null,
    {},
    { ...validStoppedEvidence, expected: 'running' },
    { ...validStoppedEvidence, matched: false },
    { ...validStoppedEvidence, blockers: ['state_mismatch'] },
    {
      ...validStoppedEvidence,
      runtime: { ...validStoppedEvidence.runtime, lifecycleState: 'unknown_unverifiable' }
    },
    {
      ...validStoppedEvidence,
      runtime: {
        ...validStoppedEvidence.runtime,
        process: { ...validStoppedEvidence.runtime.process, status: 'unverifiable' }
      }
    },
    {
      ...validStoppedEvidence,
      runtime: {
        ...validStoppedEvidence.runtime,
        port: { ...validStoppedEvidence.runtime.port, listenerCount: 1 }
      }
    }
  ])('fails issuance closed for malformed or unmatched broker evidence: %o', async (evidence) => {
    const brokerClient = new FixtureLifecycleBrokerClient(evidence)
    const authorizer = createAuthorizer(brokerClient)

    await expect(authorizer.issue(restoreIssueContext)).rejects.toEqual(
      expect.objectContaining<Partial<WindowsConfigHistoryStopProofError>>({
        code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE'
      })
    )
  })

  it('fails issuance and validation closed when the broker blocks the proof', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const token = await authorizer.issue(restoreIssueContext)
    brokerClient.result = new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_BLOCKED', {
      blockers: ['state_mismatch']
    })

    expect(await authorizer.validate(validationContext(token, 'publish'))).toBe(false)
    await expect(authorizer.issue({ operation: 'reconcile' })).rejects.toMatchObject({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE',
      message: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE'
    })
  })

  it('fails issuance and validation closed on broker errors without reflecting the token', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const token = await authorizer.issue(restoreIssueContext)
    brokerClient.result = new Error(`fictional broker failed token=${token}`)

    expect(await authorizer.validate(validationContext(token, 'publish'))).toBe(false)
    await expect(authorizer.issue({ operation: 'reconcile' })).rejects.toMatchObject({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE',
      message: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE'
    })
    try {
      await authorizer.issue({ operation: 'reconcile' })
    } catch (error) {
      expect(String(error)).not.toContain(token)
      expect(String(error)).not.toContain('fictional broker failed')
    }
  })

  it('strictly rejects unknown issue and validation context fields before calling the broker', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    const authorizer = createAuthorizer(brokerClient)
    const sensitive = 'C:\\fictional-private\\fake-secret'

    for (const field of ['path', 'scriptName', 'command', 'url', 'stopProofToken']) {
      await expect(authorizer.issue({
        ...restoreIssueContext,
        [field]: sensitive
      } as never)).rejects.toMatchObject({
        code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CONTEXT_INVALID',
        message: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CONTEXT_INVALID'
      })
    }
    expect(await authorizer.validate({
      ...validationContext('A'.repeat(43), 'prepare'),
      command: sensitive
    } as never)).toBe(false)
    expect(brokerClient.calls).toHaveLength(0)
  })

  it.each([
    { brokerClient: null },
    { brokerClient: { verify: () => Promise.resolve(validStoppedEvidence) } },
    { tokenTtlMs: 999 },
    { tokenTtlMs: 300_001 },
    { maximumTokens: 0 },
    { maximumTokens: 257 },
    { projectRoot: 'C:\\FictionalDysonProject' },
    { gamePort: 8469 },
    { runner: { run: () => Promise.resolve('{}') } },
    { unknown: 'C:\\fictional-private' }
  ])('rejects invalid, legacy, or expanded construction options: %o', (override) => {
    expect(() => new WindowsConfigHistoryStopProofAuthorizer({
      brokerClient: new FixtureLifecycleBrokerClient(),
      ...override
    } as never)).toThrow(expect.objectContaining<Partial<WindowsConfigHistoryStopProofError>>({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_OPTIONS_INVALID'
    }))
  })

  it('fails closed if the injected clock becomes invalid', async () => {
    const brokerClient = new FixtureLifecycleBrokerClient()
    let now = 10_000
    const authorizer = createAuthorizer(brokerClient, { now: () => now })
    const token = await authorizer.issue(restoreIssueContext)
    now = Number.NaN

    expect(await authorizer.validate(validationContext(token, 'prepare'))).toBe(false)
    await expect(authorizer.issue(restoreIssueContext)).rejects.toMatchObject({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_OPTIONS_INVALID'
    })
  })
})

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const requestId = '11111111-1111-4111-8111-111111111111'
const snapshotId = '22222222-2222-4222-8222-222222222222'
const otherRequestId = '33333333-3333-4333-8333-333333333333'
const otherSnapshotId = '44444444-4444-4444-8444-444444444444'
const currentRevision = 'a'.repeat(64)

const restoreIssueContext = {
  operation: 'restore' as const,
  requestId,
  snapshotId,
  expectedCurrentRevision: currentRevision,
  dryRun: false
}

type VerifyInput = Parameters<WindowsLifecycleBrokerClient['verify']>[0]
type VerifyEvidence = Awaited<ReturnType<WindowsLifecycleBrokerClient['verify']>>

const validStoppedEvidence = {
  expected: 'stopped',
  matched: true,
  blockers: [],
  runtime: {
    lifecycleState: 'stopped_verified',
    session: { status: 'missing', id: null, count: 0 },
    steam: { status: 'missing', pid: null, sessionId: null },
    process: { status: 'absent', pid: null, owner: null, sessionId: null },
    port: { port: 8469, listenerCount: 0 },
    pidFile: { present: false, valid: false }
  }
} satisfies VerifyEvidence

function validationContext(
  token: string,
  phase: 'prepare' | 'publish' | 'reconcile'
) {
  return { token, requestId, snapshotId, phase }
}

function createAuthorizer(
  brokerClient: WindowsLifecycleBrokerClient,
  overrides: {
    tokenTtlMs?: number
    maximumTokens?: number
    now?: () => number
  } = {}
) {
  return new WindowsConfigHistoryStopProofAuthorizer({ brokerClient, ...overrides })
}

type BrokerResult = unknown | Error | ((input: VerifyInput) => unknown | Promise<unknown>)

class FixtureLifecycleBrokerClient implements WindowsLifecycleBrokerClient {
  readonly signals: AbortSignal[] = []
  readonly calls: Array<{
    expected: 'running' | 'stopped'
    outerRequestId: string
    aborted: boolean
  }> = []
  result: BrokerResult

  constructor(result: BrokerResult = validStoppedEvidence) {
    this.result = result
  }

  preflight(
    _input: Parameters<WindowsLifecycleBrokerClient['preflight']>[0]
  ): ReturnType<WindowsLifecycleBrokerClient['preflight']> {
    throw new Error('unexpected preflight call')
  }

  dispatch(
    _input: Parameters<WindowsLifecycleBrokerClient['dispatch']>[0]
  ): ReturnType<WindowsLifecycleBrokerClient['dispatch']> {
    throw new Error('unexpected dispatch call')
  }

  async verify(input: VerifyInput): Promise<VerifyEvidence> {
    this.signals.push(input.signal)
    this.calls.push({
      expected: input.expected,
      outerRequestId: input.outerRequestId,
      aborted: input.signal.aborted
    })
    const result = typeof this.result === 'function'
      ? await this.result(input)
      : this.result
    if (result instanceof Error) throw result
    return result as VerifyEvidence
  }

  status(
    _input: Parameters<WindowsLifecycleBrokerClient['status']>[0]
  ): ReturnType<WindowsLifecycleBrokerClient['status']> {
    throw new Error('unexpected status call')
  }
}

import { describe, expect, it } from 'vitest'
import type { LifecycleScriptRunner, LifecycleScriptName } from './powershell-runner.js'
import {
  WindowsConfigHistoryStopProofAuthorizer,
  WindowsConfigHistoryStopProofError
} from './windows-config-history-stop-proof.js'

describe('Windows game configuration history stop-proof authorizer', () => {
  it('issues a high-entropy token after a fixed stopped check and revalidates every restore phase', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner)
    const issue = authorizer.issue
    const validate = authorizer.validate

    const token = await issue(restoreIssueContext)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await validate(validationContext(token, 'prepare'))).toBe(true)
    expect(await validate(validationContext(token, 'publish'))).toBe(true)
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls).toEqual(runner.calls.map(() => ({
      scriptName: 'Test-DysonRuntimeState.ps1',
      scriptArguments: [
        '-ProjectRoot', projectRoot,
        '-Expected', 'stopped',
        '-GamePort', '8469'
      ],
      aborted: false
    })))
    expect(JSON.stringify(authorizer)).not.toContain(token)
  })

  it('does not consume a token and binds restore grants to request and snapshot identity', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner)
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
    expect(runner.calls).toHaveLength(3)
  })

  it('forwards the host mutation cancellation signal during validation', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner)
    const token = await authorizer.issue(restoreIssueContext)
    const controller = new AbortController()

    expect(await authorizer.validate(
      validationContext(token, 'publish'), controller.signal
    )).toBe(true)
    expect(runner.signals.at(-1)).toBe(controller.signal)

    const callCount = runner.calls.length
    controller.abort('fixture-host-lease-lost')
    expect(await authorizer.validate(
      validationContext(token, 'publish'), controller.signal
    )).toBe(false)
    expect(runner.calls).toHaveLength(callCount)
  })

  it('allows one reconcile grant to revalidate multiple bounded journal contexts', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner)
    const token = await authorizer.issue({ operation: 'reconcile' })

    expect(await authorizer.validate(validationContext(token, 'reconcile'))).toBe(true)
    expect(await authorizer.validate({
      ...validationContext(token, 'reconcile'),
      requestId: otherRequestId,
      snapshotId: otherSnapshotId
    })).toBe(true)
    expect(await authorizer.validate(validationContext(token, 'prepare'))).toBe(false)
    expect(runner.calls).toHaveLength(3)
  })

  it('expires tokens at the TTL boundary and frees their bounded capacity', async () => {
    const runner = new FixtureRunner()
    let now = 10_000
    const authorizer = createAuthorizer(runner, {
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
    expect(runner.calls).toHaveLength(3)
  })

  it('rejects issuance at capacity without evicting a live grant', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner, { maximumTokens: 1 })
    const first = await authorizer.issue(restoreIssueContext)

    await expect(authorizer.issue({ operation: 'reconcile' })).rejects.toMatchObject({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CAPACITY_EXCEEDED'
    })
    expect(await authorizer.validate(validationContext(first, 'prepare'))).toBe(true)
    expect(runner.calls).toHaveLength(2)
  })

  it('serializes concurrent issuance so capacity can never be exceeded', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner, { maximumTokens: 1 })
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
    expect(runner.calls).toHaveLength(1)
  })

  it.each([
    'not-json',
    JSON.stringify({ ...validStoppedReceipt, extra: 'unexpected' }),
    JSON.stringify({ ...validStoppedReceipt, expected: 'running' }),
    JSON.stringify({ ...validStoppedReceipt, state: 'unmatched' }),
    JSON.stringify({ ...validStoppedReceipt, processVerified: false }),
    JSON.stringify({ ...validStoppedReceipt, gamePortListening: true })
  ])('fails issuance closed for an invalid runtime receipt', async (output) => {
    const runner = new FixtureRunner(output)
    const authorizer = createAuthorizer(runner)

    await expect(authorizer.issue(restoreIssueContext)).rejects.toEqual(
      expect.objectContaining<Partial<WindowsConfigHistoryStopProofError>>({
        code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE'
      })
    )
  })

  it('fails issuance and validation closed on runner errors without reflecting the token', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner)
    const token = await authorizer.issue(restoreIssueContext)
    runner.result = JSON.stringify({ ...validStoppedReceipt, gamePortListening: true })
    expect(await authorizer.validate(validationContext(token, 'publish'))).toBe(false)
    runner.result = new Error(`fictional runner failed token=${token}`)

    expect(await authorizer.validate(validationContext(token, 'publish'))).toBe(false)
    await expect(authorizer.issue({ operation: 'reconcile' })).rejects.toMatchObject({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE',
      message: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE'
    })
    try {
      await authorizer.issue({ operation: 'reconcile' })
    } catch (error) {
      expect(String(error)).not.toContain(token)
      expect(String(error)).not.toContain('fictional runner failed')
    }
  })

  it('strictly rejects unknown issue and validation context fields before running PowerShell', async () => {
    const runner = new FixtureRunner()
    const authorizer = createAuthorizer(runner)
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
    expect(runner.calls).toHaveLength(0)
  })

  it.each([
    { projectRoot: 'relative-root' },
    { gamePort: 0 },
    { tokenTtlMs: 999 },
    { tokenTtlMs: 300_001 },
    { maximumTokens: 0 },
    { maximumTokens: 257 },
    { unknown: 'C:\\fictional-private' }
  ])('rejects invalid or expanded construction options: %o', (override) => {
    expect(() => new WindowsConfigHistoryStopProofAuthorizer({
      projectRoot,
      gamePort: 8469,
      runner: new FixtureRunner(),
      ...override
    })).toThrow(expect.objectContaining<Partial<WindowsConfigHistoryStopProofError>>({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_OPTIONS_INVALID'
    }))
  })

  it('fails closed if the injected clock becomes invalid', async () => {
    const runner = new FixtureRunner()
    let now = 10_000
    const authorizer = createAuthorizer(runner, { now: () => now })
    const token = await authorizer.issue(restoreIssueContext)
    now = Number.NaN

    expect(await authorizer.validate(validationContext(token, 'prepare'))).toBe(false)
    await expect(authorizer.issue(restoreIssueContext)).rejects.toMatchObject({
      code: 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_OPTIONS_INVALID'
    })
  })
})

const projectRoot = 'C:\\FictionalDysonProject'
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

const validStoppedReceipt = {
  protocol: 'DYSON_CONTROL_RUNTIME_V1',
  expected: 'stopped',
  state: 'matched',
  processVerified: true,
  gamePortListening: false
} as const

function validationContext(
  token: string,
  phase: 'prepare' | 'publish' | 'reconcile'
) {
  return { token, requestId, snapshotId, phase }
}

function createAuthorizer(
  runner: LifecycleScriptRunner,
  overrides: {
    tokenTtlMs?: number
    maximumTokens?: number
    now?: () => number
  } = {}
) {
  return new WindowsConfigHistoryStopProofAuthorizer({
    projectRoot,
    gamePort: 8469,
    runner,
    ...overrides
  })
}

class FixtureRunner implements LifecycleScriptRunner {
  readonly signals: AbortSignal[] = []
  readonly calls: Array<{
    scriptName: LifecycleScriptName
    scriptArguments: string[]
    aborted: boolean
  }> = []
  result: string | Error

  constructor(result: string | Error = JSON.stringify(validStoppedReceipt)) {
    this.result = result
  }

  async run(
    scriptName: LifecycleScriptName,
    scriptArguments: string[],
    signal: AbortSignal
  ): Promise<string> {
    this.signals.push(signal)
    this.calls.push({ scriptName, scriptArguments: [...scriptArguments], aborted: signal.aborted })
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

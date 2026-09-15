import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FixedWindowsHostnameWssQualificationConsumer,
  WindowsHostnameWssQualificationError,
  hostnameWssQualificationConsumeConfirmation,
  hostnameWssQualificationScriptName,
  type WindowsHostnameWssQualificationPowerShellRunner
} from './windows-hostname-wss-qualification.js'

const qualificationId = '11111111-1111-1111-1111-111111111111'
const runId = '22222222-2222-2222-2222-222222222222'
const bindingSha256 = `sha256:${'a'.repeat(64)}`
const expiresAtUtc = '2099-01-01T00:00:00.000Z'

describe('fixed Windows hostname WSS qualification consumer', () => {
  it('selects only the UUID below fixed roots and accepts one exact qualified projection', async () => {
    const roots = fixedRoots()
    const projection = {
      qualificationId,
      runId,
      bindingSha256,
      expiresAtUtc,
      decision: 'qualified' as const,
      blockerCodes: [] as []
    }
    const calls: Array<[string, string[], AbortSignal]> = []
    const runner: WindowsHostnameWssQualificationPowerShellRunner = {
      async run(scriptName, args, signal) {
        calls.push([scriptName, args, signal])
        return JSON.stringify(projection)
      }
    }
    const consumer = createConsumer(roots, runner)

    await expect(consumer.consumeQualification({
      qualificationId, runId, bindingSha256, expiresAtUtc
    })).resolves.toEqual(projection)

    expect(calls).toHaveLength(1)
    const [scriptName, args, signal] = calls[0]!
    expect(scriptName).toBe(hostnameWssQualificationScriptName)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(args).toEqual([
      '-EvidenceRoot', path.join(roots.evidenceRoot, qualificationId),
      '-BuildHarvestRootA', roots.buildHarvestRootA,
      '-BuildHarvestRootB', roots.buildHarvestRootB,
      '-KeyRingRoot', roots.keyRingRoot,
      '-ReplayRoot', roots.replayRoot,
      '-ExpectedQualificationId', qualificationId,
      '-ExpectedAuthority', 'game.example.com',
      '-ExpectedPort', '443',
      '-Consume',
      '-Confirmation', hostnameWssQualificationConsumeConfirmation
    ])
  })

  it('rejects a mismatched, preview, extra-field, or malformed verifier result', async () => {
    const roots = fixedRoots()
    const request = { qualificationId, runId, bindingSha256, expiresAtUtc }
    for (const result of [
      { ...request, runId: '33333333-3333-3333-3333-333333333333', decision: 'qualified', blockerCodes: [] },
      { ...request, decision: 'preview-valid', blockerCodes: ['DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED'] },
      { ...request, decision: 'qualified', blockerCodes: [], privatePath: 'forbidden' },
      'not-json'
    ]) {
      const consumer = createConsumer(roots, {
        run: vi.fn(async () => typeof result === 'string' ? result : JSON.stringify(result))
      })
      await expect(consumer.consumeQualification(request)).rejects.toBeInstanceOf(
        WindowsHostnameWssQualificationError
      )
    }
  })

  it('maps runner failures to a bounded error and rejects caller-shaped IDs before dispatch', async () => {
    const roots = fixedRoots()
    const failingRun = vi.fn(async () => { throw new Error('private path and command output') })
    const consumer = createConsumer(roots, { run: failingRun })
    await expect(consumer.consumeQualification({
      qualificationId, runId, bindingSha256, expiresAtUtc
    })).rejects.toMatchObject({ code: 'HOSTNAME_WSS_QUALIFICATION_CONSUME_FAILED' })

    const unusedRun = vi.fn(async () => '{}')
    const rejecting = createConsumer(roots, { run: unusedRun })
    await expect(rejecting.consumeQualification({
      qualificationId: '../private-root', runId, bindingSha256, expiresAtUtc
    })).rejects.toMatchObject({ code: 'HOSTNAME_WSS_QUALIFICATION_CONSUME_REQUEST_INVALID' })
    expect(unusedRun).not.toHaveBeenCalled()
  })

  it('rejects root paths and non-canonical authorities at construction', () => {
    const roots = fixedRoots()
    const runner = { run: vi.fn(async () => '{}') }
    expect(() => createConsumer({ ...roots, replayRoot: path.parse(process.cwd()).root }, runner))
      .toThrow('HOSTNAME_WSS_QUALIFICATION_FIXED_ROOT_INVALID')
    expect(() => createConsumer({
      ...roots,
      replayRoot: path.join(roots.evidenceRoot, 'replay')
    }, runner)).toThrow('HOSTNAME_WSS_QUALIFICATION_FIXED_ROOT_OVERLAP')
    expect(() => new FixedWindowsHostnameWssQualificationConsumer({
      ...roots,
      expectedAuthority: '192.0.2.10',
      runner
    })).toThrow('HOSTNAME_WSS_QUALIFICATION_AUTHORITY_INVALID')
    expect(() => new FixedWindowsHostnameWssQualificationConsumer({
      ...roots,
      expectedAuthority: 'Game.Example.com',
      runner
    })).toThrow('HOSTNAME_WSS_QUALIFICATION_AUTHORITY_INVALID')
  })
})

function createConsumer(
  roots: ReturnType<typeof fixedRoots>,
  runner: WindowsHostnameWssQualificationPowerShellRunner
) {
  return new FixedWindowsHostnameWssQualificationConsumer({
    ...roots,
    expectedAuthority: 'game.example.com',
    runner
  })
}

function fixedRoots() {
  const root = path.join(path.parse(process.cwd()).root, 'fictional-dyson-qualification')
  return {
    evidenceRoot: path.join(root, 'evidence'),
    buildHarvestRootA: path.join(root, 'build-a'),
    buildHarvestRootB: path.join(root, 'build-b'),
    keyRingRoot: path.join(root, 'keys'),
    replayRoot: path.join(root, 'replay')
  }
}

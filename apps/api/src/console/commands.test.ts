import { describe, expect, it, vi } from 'vitest'
import type { LifecyclePreview } from '../domain.js'
import {
  ConsoleCommandError,
  executeConsoleCommand,
  previewConsoleCommand,
  type ConsoleLifecyclePort
} from './commands.js'

const lifecyclePreview: LifecyclePreview = {
  collectedAt: '2026-08-30T00:00:00.000Z',
  action: 'restart',
  mode: 'dry-run',
  allowed: true,
  executionEnabled: true,
  checks: [],
  blockers: [],
  rollback: {
    strategy: 'paired-save-backup',
    ready: true,
    summary: 'Fictional rollback is ready'
  }
}

function lifecyclePort() {
  const preview = vi.fn(async (action) => ({ ...lifecyclePreview, action }))
  const result = {
    job: { id: 'job-fixture' },
    run: { state: 'queued' },
    receipts: [],
    reused: false
  }
  const enqueue = vi.fn(() => result)
  return {
    port: { preview, enqueue } as unknown as ConsoleLifecyclePort,
    preview,
    enqueue,
    result
  }
}

describe('typed console commands', () => {
  it.each([
    ['server.start', 'start', 'START_SERVER'],
    ['server.save', 'save', 'SAVE_SERVER'],
    ['server.stop', 'graceful-stop', 'STOP_SERVER'],
    ['server.restart', 'restart', 'RESTART_SERVER']
  ] as const)('previews only the fixed %s lifecycle mapping', async (command, action, confirmation) => {
    const fixture = lifecyclePort()
    const result = await previewConsoleCommand({ command }, fixture.port)
    expect(fixture.preview).toHaveBeenCalledWith(action)
    expect(result).toMatchObject({
      mode: 'dry-run',
      command,
      requiredConfirmation: confirmation,
      lifecycle: { action }
    })
  })

  it('rejects free-form text, unknown commands, and extra input before reaching an adapter', async () => {
    const fixture = lifecyclePort()
    for (const input of [
      { command: 'shell', text: 'whoami' },
      { command: 'server.restart', text: 'anything' },
      { command: 'server.restart', executable: 'powershell.exe' },
      'server.restart'
    ]) {
      await expect(previewConsoleCommand(input, fixture.port)).rejects.toMatchObject({
        code: 'CONSOLE_COMMAND_REQUEST_INVALID'
      })
    }
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.enqueue).not.toHaveBeenCalled()
  })

  it('requires the confirmation phrase bound to the selected command', () => {
    const fixture = lifecyclePort()
    expect(() => executeConsoleCommand({
      command: 'server.restart',
      idempotencyKey: 'fixture-request-0001',
      confirmation: 'START_SERVER'
    }, fixture.port, 'Operator')).toThrowError(
      new ConsoleCommandError('CONSOLE_COMMAND_CONFIRMATION_MISMATCH')
    )
    expect(fixture.enqueue).not.toHaveBeenCalled()
  })

  it('delegates execution to the durable lifecycle queue with actor and idempotency intact', () => {
    const fixture = lifecyclePort()
    const result = executeConsoleCommand({
      command: 'server.restart',
      idempotencyKey: 'fixture-request-0001',
      confirmation: 'RESTART_SERVER'
    }, fixture.port, 'Operator')
    expect(fixture.enqueue).toHaveBeenCalledWith(
      'restart',
      'fixture-request-0001',
      'Operator'
    )
    expect(result).toBe(fixture.result)
  })

  it('rejects malformed or unbounded execution identifiers and unknown keys', () => {
    const fixture = lifecyclePort()
    for (const input of [
      {
        command: 'server.save',
        idempotencyKey: 'short',
        confirmation: 'SAVE_SERVER'
      },
      {
        command: 'server.save',
        idempotencyKey: 'fixture request with spaces',
        confirmation: 'SAVE_SERVER'
      },
      {
        command: 'server.save',
        idempotencyKey: 'fixture-request-0001',
        confirmation: 'SAVE_SERVER',
        commandLine: 'arbitrary'
      }
    ]) {
      expect(() => executeConsoleCommand(input, fixture.port, 'Operator')).toThrowError(
        new ConsoleCommandError('CONSOLE_COMMAND_REQUEST_INVALID')
      )
    }
    expect(fixture.enqueue).not.toHaveBeenCalled()
  })
})

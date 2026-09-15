import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PowerShellLifecycleRunner } from './powershell-runner.js'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
const roots: string[] = []

afterEach(async () => {
  mocked.spawn.mockReset()
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture cleanup')
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), 'dyson-output-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'Get-DysonManagedPluginVersion.ps1'), '')
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => false)
  })
  return { child, runner: new PowerShellLifecycleRunner(root, 1_000, 1_024) }
}

describe('bounded PowerShell output completion', () => {
  it('decodes split UTF-8 without inflating the raw-byte output budget', async () => {
    const { child, runner } = await fixture()
    const expected = '中'.repeat(340)
    const bytes = Buffer.from(expected)
    mocked.spawn.mockImplementation(() => {
      setImmediate(() => {
        for (let offset = 0; offset < bytes.length; offset++) {
          child.stdout.emit('data', bytes.subarray(offset, offset + 1))
        }
        child.emit('exit', 0)
        child.emit('close', 0)
      })
      return child
    })
    await expect(runner.run('Get-DysonManagedPluginVersion.ps1', [], new AbortController().signal))
      .resolves.toBe(expected)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('waits for trailing stdout after process exit', async () => {
    const { child, runner } = await fixture()
    mocked.spawn.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('{"ok":'))
        child.emit('exit', 0)
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('true}'))
          child.emit('close', 0)
        })
      })
      return child
    })
    await expect(runner.run('Get-DysonManagedPluginVersion.ps1', [], new AbortController().signal))
      .resolves.toBe('{"ok":true}')
  })

  it('does not wait indefinitely for inherited pipes after process exit', async () => {
    const { child, runner } = await fixture()
    mocked.spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })
    await expect(runner.run('Get-DysonManagedPluginVersion.ps1', [], new AbortController().signal))
      .rejects.toMatchObject({ code: 'HOST_SCRIPT_TIMEOUT' })
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('rejects output overflow even if the child never closes its pipes', async () => {
    const { child, runner } = await fixture()
    mocked.spawn.mockImplementation(() => {
      setImmediate(() => child.stderr.emit('data', Buffer.alloc(1_025)))
      return child
    })
    await expect(runner.run('Get-DysonManagedPluginVersion.ps1', [], new AbortController().signal))
      .rejects.toMatchObject({ code: 'HOST_OUTPUT_LIMIT_EXCEEDED' })
  })

  it('rejects cancellation while waiting for stream closure', async () => {
    const { child, runner } = await fixture()
    const controller = new AbortController()
    mocked.spawn.mockImplementation(() => {
      setImmediate(() => { child.emit('exit', 0); controller.abort() })
      return child
    })
    await expect(runner.run('Get-DysonManagedPluginVersion.ps1', [], controller.signal))
      .rejects.toMatchObject({ code: 'HOST_SCRIPT_ABORTED' })
  })
})

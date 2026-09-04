import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runHashPasswordCli, type PasswordInput } from './hash-password.js'
import { verifyPassword } from '../security/password.js'

function captureStream(): { stream: PassThrough, text: () => string } {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

function pipedInput(value: string): PasswordInput {
  const input = Readable.from([Buffer.from(value, 'utf8')]) as PasswordInput
  input.isTTY = false
  return input
}

class FakeTtyInput extends Readable implements PasswordInput {
  isTTY = true
  rawModes: boolean[] = []
  private readonly chunks: Buffer[]

  constructor(value: string) {
    super()
    this.chunks = [Buffer.from(value, 'utf8')]
  }

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode)
    return this
  }

  override _read(): void {
    this.push(this.chunks.shift() ?? null)
  }
}

describe('hash-password CLI', () => {
  it('reads one password from redirected stdin and emits only its hash', async () => {
    const secret = 'fictional-stdin-password'
    const stdout = captureStream()
    const stderr = captureStream()
    const exitCode = await runHashPasswordCli({
      argv: [], input: pipedInput(`${secret}\n`), stdout: stdout.stream, stderr: stderr.stream
    })

    expect(exitCode).toBe(0)
    expect(stderr.text()).toBe('')
    expect(stdout.text()).not.toContain(secret)
    expect(await verifyPassword(secret, stdout.text().trim())).toBe(true)
  })

  it('rejects argv input without reflecting the supplied secret', async () => {
    const secret = 'fictional-argv-password'
    const stdout = captureStream()
    const stderr = captureStream()
    const exitCode = await runHashPasswordCli({
      argv: [secret], input: pipedInput('unused-input\n'), stdout: stdout.stream, stderr: stderr.stream
    })

    expect(exitCode).toBe(2)
    expect(stdout.text()).toBe('')
    expect(stderr.text()).not.toContain(secret)
    expect(stderr.text()).toContain('arguments are not accepted')
  })

  it('rejects multiline redirected input without reflecting any line', async () => {
    const secret = 'fictional-first-password'
    const stdout = captureStream()
    const stderr = captureStream()
    const exitCode = await runHashPasswordCli({
      argv: [], input: pipedInput(`${secret}\nfictional-second-password\n`),
      stdout: stdout.stream, stderr: stderr.stream
    })

    expect(exitCode).toBe(1)
    expect(stdout.text()).toBe('')
    expect(stderr.text()).not.toContain('fictional')
    expect(stderr.text()).toContain('exactly one password line')
  })

  it('rejects invalid UTF-8 input without reflecting decoded content', async () => {
    const input = Readable.from([
      Buffer.concat([Buffer.from('fictional-password', 'utf8'), Buffer.from([0xff]), Buffer.from('\n')])
    ]) as PasswordInput
    input.isTTY = false
    const stdout = captureStream()
    const stderr = captureStream()
    const exitCode = await runHashPasswordCli({ argv: [], input, stdout: stdout.stream, stderr: stderr.stream })

    expect(exitCode).toBe(1)
    expect(stdout.text()).toBe('')
    expect(stderr.text()).not.toContain('fictional-password')
    expect(stderr.text()).toContain('control character')
  })

  it('uses raw terminal mode, supports backspace, and never echoes the password', async () => {
    const effectiveSecret = 'fictional-tty-password'
    const input = new FakeTtyInput(`fictional-tty-passwordX\b\r`)
    const stdout = captureStream()
    const stderr = captureStream()
    const exitCode = await runHashPasswordCli({ argv: [], input, stdout: stdout.stream, stderr: stderr.stream })

    expect(exitCode).toBe(0)
    expect(input.rawModes).toEqual([true, false])
    expect(stderr.text()).toBe('Password: \n')
    expect(stderr.text()).not.toContain(effectiveSecret)
    expect(await verifyPassword(effectiveSecret, stdout.text().trim())).toBe(true)
  })

  it('restores terminal mode after cancellation without exposing buffered text', async () => {
    const input = new FakeTtyInput('fictional-buffered-password\u0003')
    const stdout = captureStream()
    const stderr = captureStream()
    const exitCode = await runHashPasswordCli({ argv: [], input, stdout: stdout.stream, stderr: stderr.stream })

    expect(exitCode).toBe(1)
    expect(input.rawModes).toEqual([true, false])
    expect(stdout.text()).toBe('')
    expect(stderr.text()).not.toContain('fictional-buffered-password')
    expect(stderr.text()).toContain('cancelled')
  })
})

import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { hashPassword } from '../security/password.js'

const maximumPasswordCharacters = 512

export type PasswordInput = Readable & {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
}

export interface HashPasswordCliOptions {
  argv?: string[]
  input?: PasswordInput
  stdout?: Writable
  stderr?: Writable
}

function assertPasswordShape(password: string): string {
  if (password.length < 12) throw new Error('PASSWORD_TOO_SHORT')
  if (password.length > maximumPasswordCharacters) throw new Error('PASSWORD_TOO_LONG')
  if (/[\r\n\u0000-\u001f\u007f\uFFFD]/u.test(password)) throw new Error('PASSWORD_CONTROL_CHARACTER')
  return password
}

async function readPipedPassword(input: PasswordInput): Promise<string> {
  const decoder = new StringDecoder('utf8')
  let value = ''
  for await (const chunk of input) {
    value += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
    if (value.length > maximumPasswordCharacters + 2) throw new Error('PASSWORD_TOO_LONG')
  }
  value += decoder.end()
  if (value.endsWith('\r\n')) value = value.slice(0, -2)
  else if (value.endsWith('\n')) value = value.slice(0, -1)
  if (/\r|\n/u.test(value)) throw new Error('PASSWORD_MULTILINE')
  return assertPasswordShape(value)
}

function readTtyPassword(input: PasswordInput, stderr: Writable): Promise<string> {
  if (typeof input.setRawMode !== 'function') throw new Error('TTY_RAW_MODE_UNAVAILABLE')
  const decoder = new StringDecoder('utf8')
  let value = ''
  let settled = false

  stderr.write('Password: ')
  input.setRawMode(true)

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      input.off('data', onData)
      input.off('error', onError)
      input.off('end', onEnd)
      input.pause()
      input.setRawMode?.(false)
      stderr.write('\n')
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else {
        try { resolve(assertPasswordShape(value)) }
        catch (caught) { reject(caught) }
      }
    }
    const onData = (chunk: Buffer | string): void => {
      const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'))
      for (const character of decoded) {
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u0003') {
          finish(new Error('PASSWORD_CANCELLED'))
          return
        }
        if (character === '\b' || character === '\u007f') {
          value = Array.from(value).slice(0, -1).join('')
          continue
        }
        const code = character.codePointAt(0) ?? 0
        if (code < 32 || code === 127) {
          finish(new Error('PASSWORD_CONTROL_CHARACTER'))
          return
        }
        value += character
        if (value.length > maximumPasswordCharacters) {
          finish(new Error('PASSWORD_TOO_LONG'))
          return
        }
      }
    }
    const onError = (): void => finish(new Error('PASSWORD_INPUT_FAILED'))
    const onEnd = (): void => {
      value += decoder.end()
      finish()
    }
    input.on('data', onData)
    input.once('error', onError)
    input.once('end', onEnd)
    input.resume()
  })
}

export async function readPasswordWithoutEcho(
  input: PasswordInput = process.stdin,
  stderr: Writable = process.stderr
): Promise<string> {
  return input.isTTY ? readTtyPassword(input, stderr) : readPipedPassword(input)
}

function safeFailureMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  switch (code) {
    case 'PASSWORD_TOO_SHORT': return 'password must contain at least 12 characters'
    case 'PASSWORD_TOO_LONG': return `password must not exceed ${maximumPasswordCharacters} characters`
    case 'PASSWORD_MULTILINE': return 'standard input must contain exactly one password line'
    case 'PASSWORD_CONTROL_CHARACTER': return 'password contains a disallowed control character'
    case 'PASSWORD_CANCELLED': return 'password input was cancelled'
    case 'TTY_RAW_MODE_UNAVAILABLE': return 'secure terminal input is unavailable'
    case 'PASSWORD_INPUT_FAILED': return 'password input failed'
    default: return 'password hashing failed'
  }
}

export async function runHashPasswordCli(options: HashPasswordCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2)
  const input = options.input ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  if (argv.length > 0) {
    stderr.write('Password arguments are not accepted. Pipe one password on stdin or enter it at the hidden prompt.\n')
    return 2
  }
  try {
    const password = await readPasswordWithoutEcho(input, stderr)
    const encoded = await hashPassword(password)
    stdout.write(`${encoded}\n`)
    return 0
  } catch (error) {
    stderr.write(`Password hashing failed: ${safeFailureMessage(error)}.\n`)
    return 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runHashPasswordCli()
}

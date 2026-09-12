import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { ControlDatabase } from '../storage/database.js'
import { AuthService } from './auth.js'
import { hashPassword } from './password.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dyson-control-auth-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('role-aware authentication', () => {
  it('stores the configured operator role in an opaque server-side session', async () => {
    const operatorPassword = 'fictional-operator-password'
    const database = new ControlDatabase(temporaryDirectory(), true)
    const auth = new AuthService(loadConfig({
      NODE_ENV: 'test',
      DYSON_OPERATOR_PASSWORD_HASH: await hashPassword(operatorPassword)
    }), database)
    await auth.initialize()

    let cookieToken = ''
    const reply = {
      setCookie: vi.fn((_name: string, token: string) => { cookieToken = token })
    }
    expect(await auth.login(operatorPassword, reply as never, 'operator')).toBe(true)
    expect(reply.setCookie).toHaveBeenCalledWith(
      'dyson_session',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'strict' })
    )

    const request = { cookies: { dyson_session: cookieToken }, actor: null, actorRole: null }
    expect(auth.session(request as never)).toMatchObject({
      username: 'Operator',
      role: 'operator'
    })
    await auth.authenticate(request as never, {} as never)
    expect(request).toMatchObject({ actor: 'Operator', actorRole: 'operator' })
    database.close()
  })

  it('does not create a session for an unconfigured least-privilege role', async () => {
    const database = new ControlDatabase(temporaryDirectory(), true)
    const auth = new AuthService(loadConfig({ NODE_ENV: 'test' }), database)
    await auth.initialize()
    const reply = { setCookie: vi.fn() }
    expect(await auth.login('fictional-viewer-password', reply as never, 'viewer')).toBe(false)
    expect(reply.setCookie).not.toHaveBeenCalled()
    database.close()
  })
})

import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password hashing', () => {
  it('round-trips a valid password and rejects another password', async () => {
    const encoded = await hashPassword('a-unique-long-password')
    expect(await verifyPassword('a-unique-long-password', encoded)).toBe(true)
    expect(await verifyPassword('a-different-long-password', encoded)).toBe(false)
  })

  it('rejects malformed hashes without throwing', async () => {
    expect(await verifyPassword('a-unique-long-password', 'not-a-hash')).toBe(false)
  })
})

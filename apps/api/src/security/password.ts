import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const keyLength = 64
const parameters = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function scrypt(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters')
  const salt = randomBytes(16)
  const result = await scrypt(password, salt, keyLength, parameters)
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString('base64url')}$${result.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split('$')
  if (algorithm !== 'scrypt' || !n || !r || !p || !saltValue || !hashValue) return false
  const expected = Buffer.from(hashValue, 'base64url')
  if (expected.length !== keyLength) return false
  try {
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), keyLength, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    })
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

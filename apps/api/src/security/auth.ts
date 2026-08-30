import { createHmac, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { ControlDatabase } from '../storage/database.js'
import { hashPassword, verifyPassword } from './password.js'

const sessionCookie = 'dyson_session'
const sessionLifetimeMs = 12 * 60 * 60 * 1000

declare module 'fastify' {
  interface FastifyRequest {
    actor: string | null
  }
}

export class AuthService {
  readonly #config: AppConfig
  readonly #database: ControlDatabase
  #passwordHash: string | null

  constructor(config: AppConfig, database: ControlDatabase) {
    this.#config = config
    this.#database = database
    this.#passwordHash = config.adminPasswordHash
  }

  async initialize(): Promise<void> {
    if (!this.#passwordHash) this.#passwordHash = await hashPassword(this.#config.developmentPassword)
    this.#database.purgeExpiredSessions()
  }

  async login(password: string, reply: FastifyReply): Promise<boolean> {
    if (!this.#passwordHash || !(await verifyPassword(password, this.#passwordHash))) return false
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + sessionLifetimeMs)
    this.#database.createSession(this.#digest(token), 'Administrator', expiresAt.toISOString())
    reply.setCookie(sessionCookie, token, {
      httpOnly: true,
      secure: this.#config.nodeEnv === 'production',
      sameSite: 'strict',
      path: '/',
      expires: expiresAt
    })
    return true
  }

  session(request: FastifyRequest): { username: string; expiresAt: string } | null {
    const token = request.cookies[sessionCookie]
    if (!token) return null
    const row = this.#database.getSession(this.#digest(token))
    return row ? { username: row.username, expiresAt: row.expires_at } : null
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies[sessionCookie]
    if (token) this.#database.deleteSession(this.#digest(token))
    reply.clearCookie(sessionCookie, { path: '/' })
  }

  authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = this.session(request)
    if (!session) {
      await reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } })
      return
    }
    request.actor = session.username
  }

  assertSameOrigin(request: FastifyRequest): boolean {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true
    const origin = request.headers.origin
    if (!origin) return false
    if (origin === this.#config.publicOrigin) return true
    return this.#config.nodeEnv !== 'production' && origin === 'http://127.0.0.1:5173'
  }

  #digest(token: string): string {
    return createHmac('sha256', this.#config.sessionSecret).update(token).digest('hex')
  }
}

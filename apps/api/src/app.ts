import path from 'node:path'
import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import type { AppConfig } from './config.js'
import { DemoProvider } from './providers/demo.js'
import { WindowsProvider } from './providers/windows.js'
import { AuthService } from './security/auth.js'
import { ControlDatabase } from './storage/database.js'
import { EventHub } from './services/event-hub.js'
import { JobService } from './services/job-service.js'

const loginSchema = z.object({ password: z.string().min(1).max(512) })

export interface BuiltApplication {
  app: FastifyInstance
  close(): Promise<void>
}

export async function buildApplication(config: AppConfig): Promise<BuiltApplication> {
  const app = Fastify({ logger: config.nodeEnv !== 'test', trustProxy: 'loopback' })
  const database = new ControlDatabase(config.dataDir, config.nodeEnv === 'test')
  const events = new EventHub()
  const provider = config.provider === 'windows'
    ? new WindowsProvider({
        projectRoot: config.projectRoot!, scriptRoot: config.scriptRoot, timeoutMs: config.statusTimeoutMs
      })
    : new DemoProvider()
  const jobs = new JobService(database, provider, events)
  const auth = new AuthService(config, database)

  await app.register(cookie)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    }
  })
  await app.register(rateLimit, { global: false })
  await auth.initialize()

  app.decorateRequest('actor', null)

  app.addHook('onRequest', async (request, reply) => {
    if (!auth.assertSameOrigin(request)) {
      await reply.code(403).send({ error: { code: 'ORIGIN_REJECTED', message: 'Request origin rejected' } })
    }
  })

  app.get('/healthz', async () => ({ status: 'ok', provider: provider.name }))

  app.post('/api/v1/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success || !(await auth.login(parsed.data.password, reply))) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' } })
    }
    return { user: { name: 'Administrator' } }
  })

  app.get('/api/v1/auth/session', async (request, reply) => {
    const session = auth.session(request)
    if (!session) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } })
    return { user: { name: session.username }, expiresAt: session.expiresAt }
  })

  app.post('/api/v1/auth/logout', { preHandler: auth.authenticate }, async (request, reply) => {
    auth.logout(request, reply)
    return reply.code(204).send()
  })

  app.get('/api/v1/status', { preHandler: auth.authenticate }, async (_request, reply) => {
    let status = jobs.latestStatus()
    if (!status) {
      try { status = await jobs.collectInitialStatus() }
      catch { return reply.code(503).send({ error: { code: 'STATUS_UNAVAILABLE', message: '服务器状态暂不可用' } }) }
    }
    return { data: status, meta: { provider: provider.name } }
  })

  app.get('/api/v1/jobs', { preHandler: auth.authenticate }, async () => ({ data: jobs.listJobs() }))
  app.get('/api/v1/jobs/:id', { preHandler: auth.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id
    const job = jobs.getJob(id)
    return job ? { data: job } : reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: '任务不存在' } })
  })

  app.post('/api/v1/actions/refresh', { preHandler: auth.authenticate }, async (request, reply) => {
    const job = jobs.enqueueRefresh(request.actor ?? 'unknown')
    return reply.code(202).send({ data: job })
  })

  app.get('/api/v1/events', { preHandler: auth.authenticate }, async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    reply.raw.write(': connected\n\n')
    const unsubscribe = events.subscribe((event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    })
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 20_000)
    request.raw.once('close', () => { clearInterval(heartbeat); unsubscribe() })
  })

  const webRoot = path.resolve(import.meta.dirname, '..', '..', 'web', 'dist')
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
      }
      return reply.sendFile('index.html')
    })
  }

  return {
    app,
    async close() { await app.close(); database.close() }
  }
}

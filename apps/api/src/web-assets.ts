import type { FastifyInstance, FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'

/** Deterministic archives give index.html a fixed mtime; size/mtime ETags are not release identities. */
export async function registerWebAssets(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, { root: webRoot, prefix: '/' })
  const sendEntry = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store')
    .sendFile('index.html', { etag: false, lastModified: false, cacheControl: false })
  app.get('/', (_request, reply) => sendEntry(reply))
  app.get('/index.html', (_request, reply) => sendEntry(reply))
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/assets/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
    }
    return sendEntry(reply)
  })
}

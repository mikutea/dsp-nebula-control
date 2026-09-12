import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { afterEach, describe, expect, it } from 'vitest'
import { registerWebAssets } from './web-assets.js'

const roots: string[] = []
const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(label: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dyson-web-cache-')))
  roots.push(root)
  await mkdir(path.join(root, 'assets'))
  await writeFile(path.join(root, 'index.html'), `<script src="/assets/${label}.js"></script>`)
  const fixed = new Date('1980-01-01T00:00:00Z')
  await utimes(path.join(root, 'index.html'), fixed, fixed)
  await writeFile(path.join(root, 'assets', `${label}.js`), 'console.log("fixture")')
  const app = Fastify()
  apps.push(app)
  return { root, app }
}

describe('release entry document caching', () => {
  it('serves the new entry even when the old release has identical size and timestamp', async () => {
    const previous = await fixture('old')
    await previous.app.register(fastifyStatic, { root: previous.root })
    const cached = await previous.app.inject('/')
    expect(cached.headers.etag).toBeTruthy()
    const current = await fixture('new')
    await registerWebAssets(current.app, current.root)
    for (const url of ['/', '/index.html', '/configuration']) {
      const response = await current.app.inject({ method: 'GET', url, headers: {
        'if-none-match': String(cached.headers.etag),
        'if-modified-since': String(cached.headers['last-modified'])
      } })
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('/assets/new.js')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers.etag).toBeUndefined()
      expect(response.headers['last-modified']).toBeUndefined()
    }
  })

  it('retains asset revalidation and never substitutes HTML for a missing asset or API', async () => {
    const current = await fixture('new')
    await registerWebAssets(current.app, current.root)
    const asset = await current.app.inject('/assets/new.js')
    expect(asset.statusCode).toBe(200)
    const cached = await current.app.inject({ url: '/assets/new.js', headers: { 'if-none-match': String(asset.headers.etag) } })
    expect(cached.statusCode).toBe(304)
    for (const url of ['/assets/old.js', '/api/missing']) {
      const missing = await current.app.inject(url)
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    }
  })
})

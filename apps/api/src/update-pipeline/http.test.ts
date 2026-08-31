import { describe, expect, it, vi } from 'vitest'
import { BoundedJsonClient, type FetchLike } from './http.js'

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  const body = JSON.stringify(value)
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  })
}

describe('bounded JSON client', () => {
  it('uses only an allowlisted HTTPS endpoint and parses a bounded response', async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }))
    const client = new BoundedJsonClient({ fetch, allowedHosts: ['api.example.com'] })
    await expect(client.get(new URL('https://api.example.com/releases?page=1'))).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://api.example.com/releases?page=1')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
  })

  it('rejects hostile URL forms before fetch and refuses oversized or non-JSON responses', async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }))
    const client = new BoundedJsonClient({
      fetch,
      allowedHosts: ['api.example.com'],
      maxResponseBytes: 1_024
    })
    await expect(client.get(new URL('https://attacker.example/releases')))
      .rejects.toThrow('DISCOVERY_URL_NOT_ALLOWED')
    await expect(client.get(new URL('http://api.example.com/releases')))
      .rejects.toThrow('DISCOVERY_URL_NOT_ALLOWED')
    await expect(client.get(new URL('https://user:pass@api.example.com/releases')))
      .rejects.toThrow('DISCOVERY_URL_NOT_ALLOWED')
    expect(fetch).not.toHaveBeenCalled()

    const oversized = new BoundedJsonClient({
      fetch: async () => new Response(JSON.stringify({ payload: 'x'.repeat(1_100) }), {
        headers: { 'content-type': 'application/json' }
      }),
      allowedHosts: ['api.example.com'],
      maxResponseBytes: 1_024
    })
    await expect(oversized.get(new URL('https://api.example.com/releases')))
      .rejects.toThrow('DISCOVERY_RESPONSE_TOO_LARGE')

    const html = new BoundedJsonClient({
      fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      allowedHosts: ['api.example.com']
    })
    await expect(html.get(new URL('https://api.example.com/releases')))
      .rejects.toThrow('DISCOVERY_CONTENT_TYPE_INVALID')
  })

  it('enforces a bounded timeout through the injected fetch signal', async () => {
    const fetch: FetchLike = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    const client = new BoundedJsonClient({
      fetch,
      allowedHosts: ['api.example.com'],
      timeoutMs: 100
    })
    await expect(client.get(new URL('https://api.example.com/releases')))
      .rejects.toThrow('DISCOVERY_REQUEST_TIMEOUT')
  })
})

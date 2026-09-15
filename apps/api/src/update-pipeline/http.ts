import { z } from 'zod'
import { UpdatePipelineError } from './errors.js'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface BoundedJsonClientOptions {
  fetch: FetchLike
  allowedHosts: readonly string[]
  timeoutMs?: number
  maxResponseBytes?: number
  userAgent?: string
}

export interface BoundedJsonRequestOptions {
  signal?: AbortSignal
  headers?: Readonly<Record<string, string>>
}

const optionsSchema = z.strictObject({
  allowedHosts: z.array(z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/)).min(1).max(8),
  timeoutMs: z.number().int().min(100).max(30_000),
  maxResponseBytes: z.number().int().min(1_024).max(8 * 1_024 * 1_024),
  userAgent: z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/)
})

export class BoundedJsonClient {
  readonly #fetch: FetchLike
  readonly #allowedHosts: ReadonlySet<string>
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #userAgent: string

  constructor(options: BoundedJsonClientOptions) {
    const parsed = optionsSchema.parse({
      allowedHosts: [...options.allowedHosts].map((host) => host.toLowerCase()),
      timeoutMs: options.timeoutMs ?? 8_000,
      maxResponseBytes: options.maxResponseBytes ?? 512 * 1_024,
      userAgent: options.userAgent ?? 'dyson-control-update-discovery/0.1'
    })
    if (new Set(parsed.allowedHosts).size !== parsed.allowedHosts.length) {
      throw new UpdatePipelineError('DISCOVERY_HOST_ALLOWLIST_DUPLICATE')
    }
    this.#fetch = options.fetch
    this.#allowedHosts = new Set(parsed.allowedHosts)
    this.#timeoutMs = parsed.timeoutMs
    this.#maxResponseBytes = parsed.maxResponseBytes
    this.#userAgent = parsed.userAgent
  }

  async get(url: URL, options: BoundedJsonRequestOptions = {}): Promise<unknown> {
    assertTrustedHttpsUrl(url, this.#allowedHosts)
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort('timeout')
    }, this.#timeoutMs)
    const abortFromCaller = (): void => controller.abort(options.signal?.reason ?? 'caller-aborted')
    if (options.signal?.aborted === true) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    try {
      let response: Response
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'user-agent': this.#userAgent,
            ...options.headers
          }
        })
      } catch (error) {
        if (controller.signal.aborted) {
          throw new UpdatePipelineError(
            timedOut ? 'DISCOVERY_REQUEST_TIMEOUT' : 'DISCOVERY_REQUEST_ABORTED',
            { cause: error }
          )
        }
        throw new UpdatePipelineError('DISCOVERY_REQUEST_FAILED', { cause: error })
      }

      if (response.url !== '') assertTrustedHttpsUrl(new URL(response.url), this.#allowedHosts)
      if (!response.ok) throw new UpdatePipelineError('DISCOVERY_HTTP_STATUS_INVALID')
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json' && contentType !== 'application/vnd.github+json') {
        throw new UpdatePipelineError('DISCOVERY_CONTENT_TYPE_INVALID')
      }
      const declaredLength = response.headers.get('content-length')
      if (declaredLength !== null) {
        const parsedLength = Number(declaredLength)
        if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > this.#maxResponseBytes) {
          throw new UpdatePipelineError('DISCOVERY_RESPONSE_TOO_LARGE')
        }
      }
      let bytes: Uint8Array
      try {
        bytes = await readBoundedBody(response, this.#maxResponseBytes, controller.signal)
      } catch (error) {
        if (error instanceof UpdatePipelineError && error.code !== 'DISCOVERY_REQUEST_ABORTED') throw error
        if (controller.signal.aborted) {
          throw new UpdatePipelineError(
            timedOut ? 'DISCOVERY_REQUEST_TIMEOUT' : 'DISCOVERY_REQUEST_ABORTED',
            { cause: error }
          )
        }
        throw new UpdatePipelineError('DISCOVERY_RESPONSE_READ_FAILED', { cause: error })
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (error) {
        throw new UpdatePipelineError('DISCOVERY_RESPONSE_ENCODING_INVALID', { cause: error })
      }
      try {
        return JSON.parse(text) as unknown
      } catch (error) {
        throw new UpdatePipelineError('DISCOVERY_RESPONSE_JSON_INVALID', { cause: error })
      }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

export function assertTrustedHttpsUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') ||
      url.username !== '' || url.password !== '' || url.hash !== '' ||
      !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new UpdatePipelineError('DISCOVERY_URL_NOT_ALLOWED')
  }
}

async function readBoundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) throw new UpdatePipelineError('DISCOVERY_RESPONSE_BODY_MISSING')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      if (signal.aborted) throw new UpdatePipelineError('DISCOVERY_REQUEST_ABORTED')
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximumBytes) throw new UpdatePipelineError('DISCOVERY_RESPONSE_TOO_LARGE')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

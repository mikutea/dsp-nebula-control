import type { JobRecord, LifecycleAction, LifecyclePreview, ServerStatus } from './model'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new ApiError(response.status, body?.error?.message ?? `HTTP ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  session: () => request<{ user: { name: string } }>('/api/v1/auth/session'),
  login: (password: string) => request<{ user: { name: string } }>('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ password })
  }),
  logout: () => request<void>('/api/v1/auth/logout', { method: 'POST' }),
  status: () => request<{ data: ServerStatus; meta: { provider: 'demo' | 'windows' } }>('/api/v1/status'),
  jobs: () => request<{ data: JobRecord[] }>('/api/v1/jobs'),
  refresh: () => request<{ data: JobRecord }>('/api/v1/actions/refresh', { method: 'POST' }),
  previewLifecycle: (action: LifecycleAction) => request<{
    data: { job: JobRecord; preview: LifecyclePreview }
  }>('/api/v1/actions/lifecycle/preview', {
    method: 'POST', body: JSON.stringify({ action })
  })
}

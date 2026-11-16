export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly body: Record<string, unknown>) {
    super(`${status} ${code}`)
  }
}

type ApiDeps = { token: () => Promise<string | null>; fetch?: typeof fetch }

export function createApiClient(deps: ApiDeps) {
  const doFetch = deps.fetch ?? fetch

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await deps.token()
    if (!token) throw new ApiError(401, 'unauthenticated', {})
    const headers = new Headers({ Authorization: `Bearer ${token}` })
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    const response = await doFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) throw new ApiError(response.status, typeof parsed.error === 'string' ? parsed.error : 'request_failed', parsed)
    return parsed as T
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    send: <T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown) => request<T>(method, path, body),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

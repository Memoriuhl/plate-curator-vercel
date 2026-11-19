export const batchApiPath = (id: string) =>
  `/api/batches/${encodeURIComponent(id)}`

export const dashboardDraftPath = (code: string) =>
  `/api/batches?dashboard=${code}`

/** Match state-scoped Dashboard reads without matching the legacy overlay. */
export function isDashboardDraftKey(key: unknown, code?: string): boolean {
  if (typeof key !== 'string') return false
  return code === undefined
    ? /^\/api\/batches\?dashboard=[A-Z]{2}&catalogVersion=/.test(key)
    : key.startsWith(`${dashboardDraftPath(code)}&catalogVersion=`)
}

export class ApiError extends Error {
  /**
   * Preserve the HTTP status, application error code and response body for callers that
   * handle conflicts.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>
  ) {
    super(`${status} ${code}`)
  }
}

type ApiDeps = { token: () => Promise<string | null>; fetch?: typeof fetch }

/** Build the authenticated API client shared by session hooks. */
export function createApiClient(deps: ApiDeps) {
  const doFetch = deps.fetch ?? fetch

  /**
   * Send a request with the current ID token and turn unsuccessful responses into typed
   * API errors.
   */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await deps.token()
    if (!token) throw new ApiError(401, 'unauthenticated', {})
    const headers = new Headers({ Authorization: `Bearer ${token}` })
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    const response = await doFetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const parsed = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    if (!response.ok)
      throw new ApiError(
        response.status,
        typeof parsed.error === 'string' ? parsed.error : 'request_failed',
        parsed
      )
    return parsed as T
  }

  return {
    /** Load a typed resource through the authenticated API client. */
    get: <T>(path: string) => request<T>('GET', path),
    /** Send a typed write request through the authenticated API client. */
    send: <T>(
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown
    ) => request<T>(method, path, body),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

/** Extract validation reasons so forms can show specific messages. */
export function apiErrorReasons(error: unknown): string[] {
  return error instanceof ApiError && Array.isArray(error.body.reasons)
    ? error.body.reasons.filter(
        (reason): reason is string => typeof reason === 'string'
      )
    : []
}

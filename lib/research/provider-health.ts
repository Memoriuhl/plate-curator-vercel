export const searchProviderEnv = {
  serper: 'SERPER_API_KEY',
  brave: 'BRAVE_API_KEY',
} as const
export type SearchProvider = keyof typeof searchProviderEnv
export type SearchProviderStatus =
  | 'configured'
  | 'available'
  | 'missing_key'
  | 'auth_failed'
  | 'over_quota'
  | 'rate_limited'
  | 'unreachable'
  | 'error'
export type SearchProviderHealth = {
  provider: SearchProvider
  envVar: (typeof searchProviderEnv)[SearchProvider]
  status: SearchProviderStatus
  /** True when a live request was made; false for a configuration-only check. */
  checked: boolean
  reason: string
  httpStatus?: number
  /** Provider error code, when the response carried one. Never key material. */
  code?: string
  /** The provider's X-RateLimit headers, as sent. Brave lists per-second, per-month. */
  quota?: { limit?: string; remaining?: string }
}
export type SearchMode = 'serper-brave' | 'gateway-parallel'

const probeQuery = 'Arizona license plate'

/** Remove every key value from provider text before it is returned or logged. */
function redact(text: string, keys: string[]) {
  return keys
    .filter(Boolean)
    .reduce((value, key) => value.split(key).join('[redacted]'), text)
    .slice(0, 200)
}

/** Read the provider's error code or message from a JSON or text body. */
function errorDetail(body: string): { code?: string; message: string } {
  try {
    const data = JSON.parse(body) as {
      message?: unknown
      error?: { code?: unknown; detail?: unknown } | unknown
    }
    const error =
      data.error && typeof data.error === 'object'
        ? (data.error as { code?: unknown; detail?: unknown })
        : undefined
    return {
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      message: String(
        error?.detail ?? data.message ?? (error ? '' : (data.error ?? ''))
      ),
    }
  } catch {
    return { message: body }
  }
}

/** Map a failed provider response to the reason an operator can act on. */
function classify(
  status: number,
  detail: { code?: string; message: string }
): { status: SearchProviderStatus; reason: string } {
  const text = `${detail.code ?? ''} ${detail.message}`
  if (
    status === 401 ||
    status === 403 ||
    /TOKEN_INVALID|invalid (api )?key|unauthori[sz]ed/i.test(text)
  )
    return { status: 'auth_failed', reason: 'The provider rejected the key.' }
  // A per-second limit is RATE_LIMITED even when its message says "exceeded".
  if (status === 402 || /QUOTA|credit/i.test(text))
    return {
      status: 'over_quota',
      reason: 'The account has no remaining search quota.',
    }
  if (status === 429)
    return {
      status: 'rate_limited',
      reason: 'The provider is limiting request rate; retry shortly.',
    }
  return {
    status: 'error',
    reason: `The provider returned HTTP ${status}.`,
  }
}

/** Send one small search with the configured key and classify the response. */
async function probe(
  provider: SearchProvider,
  key: string,
  request: typeof fetch,
  keys: string[]
): Promise<Omit<SearchProviderHealth, 'provider' | 'envVar' | 'checked'>> {
  let response: Response
  try {
    response =
      provider === 'serper'
        ? await request('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: probeQuery, num: 1 }),
            signal: AbortSignal.timeout(10000),
          })
        : await request(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(probeQuery)}&count=1`,
            {
              headers: {
                'X-Subscription-Token': key,
                Accept: 'application/json',
              },
              signal: AbortSignal.timeout(10000),
            }
          )
  } catch {
    return {
      status: 'unreachable',
      reason: 'The provider could not be reached from this environment.',
    }
  }
  const limit = response.headers.get('X-RateLimit-Limit') ?? undefined
  const remaining = response.headers.get('X-RateLimit-Remaining') ?? undefined
  const quota =
    limit || remaining
      ? {
          quota: {
            ...(limit ? { limit } : {}),
            ...(remaining ? { remaining } : {}),
          },
        }
      : {}
  if (response.ok)
    return { status: 'available', reason: 'A test search succeeded.', ...quota }
  const detail = errorDetail(
    redact(await response.text().catch(() => ''), keys)
  )
  return {
    ...classify(response.status, detail),
    httpStatus: response.status,
    ...(detail.code ? { code: redact(detail.code, keys) } : {}),
    ...quota,
  }
}

/**
 * Report which web search providers can serve research, and why any cannot. Without
 * `probe` it only checks configuration; with `probe` it spends one search per
 * configured provider. Key values never appear in the result.
 */
export async function searchProviderHealth(options: {
  keys: Partial<Record<SearchProvider, string>>
  probe: boolean
  mode?: SearchMode
  fetch?: typeof fetch
}): Promise<{ mode: SearchMode; providers: SearchProviderHealth[] }> {
  const request = options.fetch ?? fetch
  const keys = Object.values(options.keys).filter((key): key is string => !!key)
  const providers = await Promise.all(
    (Object.keys(searchProviderEnv) as SearchProvider[]).map(
      async (provider): Promise<SearchProviderHealth> => {
        const envVar = searchProviderEnv[provider]
        const key = options.keys[provider]?.trim()
        if (!key)
          return {
            provider,
            envVar,
            status: 'missing_key',
            checked: false,
            reason: `${envVar} is not set in this environment.`,
          }
        if (!options.probe)
          return {
            provider,
            envVar,
            status: 'configured',
            checked: false,
            reason: `${envVar} is set; run a probe to confirm it works.`,
          }
        return {
          provider,
          envVar,
          checked: true,
          ...(await probe(provider, key, request, keys)),
        }
      }
    )
  )
  return { mode: options.mode ?? 'serper-brave', providers }
}

/** Read provider keys and search mode from the current process environment. */
export function searchProviderEnvironment() {
  return {
    keys: {
      serper: process.env.SERPER_API_KEY,
      brave: process.env.BRAVE_API_KEY,
    },
    mode:
      process.env.RESEARCH_SEARCH_PROVIDER === 'gateway-parallel'
        ? ('gateway-parallel' as const)
        : ('serper-brave' as const),
  }
}

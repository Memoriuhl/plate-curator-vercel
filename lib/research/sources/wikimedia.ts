/** Public page that identifies this client to the sites research reads. */
export const clientContactUrl = 'https://plate-curator-vercel.vercel.app'

/**
 * User-Agent strings in the form Wikimedia's User-Agent policy asks for: client name and
 * version, then contact information in parentheses. The contact is the app URL; no
 * personal email goes in a request header.
 */
export const researchUserAgent = `PlateCuratorResearch/1.0 (${clientContactUrl})`
export const localPipelineUserAgent = `PlateCuratorLocal/1.0 (${clientContactUrl})`

/** Wikipedia, Wikimedia Commons and the other Wikimedia project domains. */
export function isWikimediaHost(hostname: string) {
  return /(^|\.)(wikipedia|wikimedia)\.org$/i.test(hostname)
}

/**
 * Bounds for repeating a rate-limited request: two retries at most, and no single wait
 * longer than ten seconds. Without a Retry-After header the wait doubles from one second.
 */
export const rateLimitRetry = {
  retries: 2,
  maxWaitMs: 10_000,
  backoffMs: 1_000,
} as const

/**
 * Read Retry-After as delay seconds or an HTTP date; anything else is ignored. HTTP dates
 * start with a day name, which keeps loose strings such as "-1" away from `Date.parse`.
 */
export function retryAfterMs(
  header: string | null,
  now: number
): number | undefined {
  const value = header?.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1000
  if (!/^[a-z]{3}/i.test(value)) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/**
 * Send a request and, while it answers 429, wait and send it again. A Retry-After header
 * sets the wait and the request is never repeated sooner. When the server asks for
 * longer than the bound, or the retries run out, the 429 response is returned and the
 * caller handles it as it handles any failed response. `send` builds each request, so
 * every attempt gets its own timeout signal.
 */
export async function withRateLimitRetry(
  send: () => Promise<Response>,
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<Response> {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = deps.now ?? Date.now
  for (let retry = 0; ; retry++) {
    const response = await send()
    if (response.status !== 429 || retry === rateLimitRetry.retries)
      return response
    const wait =
      retryAfterMs(response.headers.get('retry-after'), now()) ??
      rateLimitRetry.backoffMs * 2 ** retry
    if (wait > rateLimitRetry.maxWaitMs) return response
    await response.body?.cancel()
    await sleep(wait)
  }
}

import { timingSafeEqual } from 'node:crypto'

/** Reject workflow spike requests that lack the configured shared secret. */
export function rejectWithoutSpikeSecret(request: Request, secret: string | undefined): Response | null {
  const given = request.headers.get('x-spike-secret')
  if (secret && given && sameSecret(given, secret)) return null
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}

/** Compare two equal-length secrets in constant time. */
function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
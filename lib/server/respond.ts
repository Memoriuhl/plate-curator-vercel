import { plateRevision } from '../review/draft/revision'
import type { Outcome, ReviewError } from '../review/types'

// Keep authenticated API responses out of HTTP caches so clients can revalidate live state.
const headers = { 'Cache-Control': 'private, no-store' }

const statusFor: Record<ReviewError, number> = {
  pipeline_busy: 409,
  standard_change_unconfirmed: 409,
  standard_required: 422,
  standard_invalid_template: 422,
  forbidden: 403,
  not_found: 404,
  stale_plate: 409,
  superseded_revision: 409,
  invalid_state: 422,
}

/** Return JSON with the common private response headers used by curator APIs. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers })
}

/** Map review outcomes to HTTP responses and include requested plate revision data. */
export function respond<T>(outcome: Outcome<T>): Response {
  if (outcome.ok) return json(outcome.value)
  return json(
    {
      error: outcome.error,
      ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
      ...(outcome.reasons ? { reasons: outcome.reasons } : {}),
      ...(outcome.currentEditVersion !== undefined
        ? { currentEditVersion: outcome.currentEditVersion }
        : {}),
      ...(outcome.current
        ? {
            current: outcome.current,
            currentRevision: plateRevision(outcome.current),
          }
        : {}),
    },
    statusFor[outcome.error]
  )
}

/**
 * Read a JSON object from a request and treat malformed or non-object bodies as invalid.
 */
export async function readJson(
  request: Request
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Return the standard bad-request response for invalid curator API input. */
export const badRequest = () => json({ error: 'bad_request' }, 400)

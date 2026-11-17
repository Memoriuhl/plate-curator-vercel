import { plateRevision } from '../review/revision'
import type { Outcome, ReviewError } from '../review/types'

const headers = { 'Cache-Control': 'private, no-store' }

const statusFor: Record<ReviewError, number> = {
  standard_change_unconfirmed: 409,
  standard_required: 422,
  standard_invalid_template: 422,
  forbidden: 403,
  not_found: 404,
  stale_plate: 409,
  superseded_revision: 409,
  invalid_state: 422,
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers })
}

export function respond<T>(outcome: Outcome<T>): Response {
  if (outcome.ok) return json(outcome.value)
  return json({ error: outcome.error, ...(outcome.current ? { current: outcome.current, currentRevision: plateRevision(outcome.current) } : {}) }, statusFor[outcome.error])
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const badRequest = () => json({ error: 'bad_request' }, 400)

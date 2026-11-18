import { createHash, randomBytes } from 'node:crypto'
import type { Member } from './types'

/** Generate an unpredictable invitation secret suitable for a URL path. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hash a raw invitation token for lookup without retaining the usable secret. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Create a time-bound invitation record from the issued token and clock. */
export function createInvite(token: string, now: () => string = () => new Date().toISOString()): NonNullable<Member['invite']> {
  const issuedAt = now()
  return { tokenHash: hashInviteToken(token), issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 7 * 24 * 60 * 60 * 1000).toISOString() }
}

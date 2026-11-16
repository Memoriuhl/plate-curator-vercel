import { createHash, randomBytes } from 'node:crypto'
import type { Member } from './types'

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createInvite(token: string, now: () => string = () => new Date().toISOString()): NonNullable<Member['invite']> {
  const issuedAt = now()
  return { tokenHash: hashInviteToken(token), issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 7 * 24 * 60 * 60 * 1000).toISOString() }
}

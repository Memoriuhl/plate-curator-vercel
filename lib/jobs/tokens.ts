import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Actor } from '../review/types'
import type { JobsDeps, Outcome } from './types'

/**
 * Hash a presented token so the store can address its record without retaining the raw
 * secret.
 */
function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Issue a random worker credential for an owner and persist only the hash and token
 * metadata.
 */
export async function issueWorkerToken(
  d: JobsDeps,
  actor: Actor,
  workerId: string
): Promise<Outcome<{ token: string; hash: string }>> {
  if (actor.role !== 'owner') return { ok: false, error: 'forbidden' }
  const token = randomBytes(32).toString('base64url')
  const hash = tokenHash(token)
  await d.store.createToken({
    hash,
    workerId,
    env: d.store.env,
    createdAt: d.now(),
    revokedAt: null,
  })
  return { ok: true, value: { token, hash } }
}

/**
 * Resolve a valid token to its worker using a timing-safe comparison and environment
 * checks.
 */
export async function verifyWorkerToken(
  d: JobsDeps,
  token: string
): Promise<string | null> {
  if (typeof token !== 'string' || !token) return null
  const hash = tokenHash(token)
  const stored = await d.store.getToken(hash)
  const expected = Buffer.from(stored?.hash ?? '0'.repeat(64), 'hex')
  const matches =
    expected.length === 32 &&
    timingSafeEqual(Buffer.from(hash, 'hex'), expected)
  return matches &&
    stored &&
    stored.revokedAt === null &&
    stored.env === d.store.env
    ? stored.workerId
    : null
}

/** Allow an owner to revoke a worker token in the current environment. */
export async function revokeWorkerToken(
  d: JobsDeps,
  actor: Actor,
  hash: string
): Promise<Outcome<null>> {
  if (actor.role !== 'owner') return { ok: false, error: 'forbidden' }
  await d.store.revokeToken(hash, d.now())
  return { ok: true, value: null }
}

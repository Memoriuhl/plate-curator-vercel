import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { ResearchStore } from './store'
import type { ResearchJob } from './types'

/**
 * Hash a research credential so the store can look it up without persisting the secret.
 */
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Issue a research worker credential and save its hash, owner and environment. */
export async function issueResearchWorkerToken(
  store: ResearchStore,
  workerId: string
) {
  if (!workerId.trim() || workerId.length > 64)
    throw new Error('Invalid worker identity')
  const token = randomBytes(32).toString('base64url')
  const digest = hash(token)
  await store.setToken({
    hash: digest,
    workerId,
    env: store.env,
    createdAt: Date.now(),
    revokedAt: null,
  })
  return { token, hash: digest, workerId }
}

/**
 * Authenticate a worker by resolving an active bearer-token hash in the current
 * environment.
 */
export async function researchWorkerIdentity(
  store: ResearchStore,
  request: Request
) {
  const token = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get('authorization') ?? ''
  )?.[1]
  if (!token) return null
  const record = await store.getToken(hash(token))
  return record && record.revokedAt === null && record.env === store.env
    ? record.workerId
    : null
}

/** Record revocation on an existing research worker credential by its hash. */
export async function revokeResearchWorkerToken(
  store: ResearchStore,
  digest: string
) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid token hash')
  const record = await store.getToken(digest)
  if (record) await store.setToken({ ...record, revokedAt: Date.now() })
}

/**
 * Sign a short-lived service credential carrying the job and owner identity Eve needs.
 */
export async function researchServiceToken(
  job: Pick<ResearchJob, 'id' | 'env' | 'requestedBy'>,
  secret: string
) {
  if (secret.length < 32)
    throw new Error(
      'RESEARCH_SERVICE_SECRET must contain at least 32 characters'
    )
  return new SignJWT({ jobId: job.id, env: job.env })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('plate-curator-research')
    .setAudience('eve-research')
    .setSubject(job.requestedBy)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(secret))
}

/**
 * Verify the service credential's signature, expiry and expected claims before trusting
 * its identity.
 */
export async function verifyResearchServiceToken(
  token: string,
  secret: string,
  env: string
) {
  if (secret.length < 32) return null
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      {
        algorithms: ['HS256'],
        issuer: 'plate-curator-research',
        audience: 'eve-research',
      }
    )
    return payload.env === env &&
      typeof payload.sub === 'string' &&
      typeof payload.jobId === 'string'
      ? { uid: payload.sub, jobId: payload.jobId }
      : null
  } catch {
    return null
  }
}

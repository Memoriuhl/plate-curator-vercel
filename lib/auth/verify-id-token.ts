import { jwtVerify } from 'jose'
import type { JWTVerifyGetKey } from 'jose'

export type VerifiedIdentity = { uid: string; email?: string; name?: string; signInProvider: string | null; emailVerified: boolean }

export async function verifyIdToken(token: string, deps: { projectId: string; jwks: JWTVerifyGetKey; now?: () => number }): Promise<VerifiedIdentity | null> {
  try {
    const now = (deps.now ?? Date.now)()
    const { payload } = await jwtVerify(token, deps.jwks, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${deps.projectId}`,
      audience: deps.projectId,
      currentDate: new Date(now),
      requiredClaims: ['exp', 'sub', 'auth_time'],
    })
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) return null
    if (typeof payload.auth_time !== 'number' || !Number.isFinite(payload.auth_time) || payload.auth_time > now / 1000) return null
    const firebase = payload.firebase
    const signInProvider = firebase && typeof firebase === 'object' && 'sign_in_provider' in firebase && typeof firebase.sign_in_provider === 'string' ? firebase.sign_in_provider : null
    return { uid: payload.sub, signInProvider, emailVerified: payload.email_verified === true, ...(typeof payload.name === 'string' ? { name: payload.name } : {}), ...(typeof payload.email === 'string' ? { email: payload.email } : {}) }
  } catch {
    return null
  }
}

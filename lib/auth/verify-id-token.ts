import { jwtVerify, UnsecuredJWT } from 'jose'
import type { JWTPayload, JWTVerifyGetKey } from 'jose'

export type VerifiedIdentity = {
  uid: string
  email?: string
  name?: string
  signInProvider: string | null
  emailVerified: boolean
}

/**
 * Accept the Auth emulator's unsigned tokens only for a local `demo-` project. Firebase
 * reserves that prefix for emulator-only projects, so a real project never qualifies.
 */
export function authEmulatorEnabled(
  projectId: string,
  env: {
    FIREBASE_AUTH_EMULATOR_HOST?: string
    VERCEL_ENV?: string
    NODE_ENV?: string
  } = process.env
): boolean {
  return (
    Boolean(env.FIREBASE_AUTH_EMULATOR_HOST?.trim()) &&
    projectId.startsWith('demo-') &&
    env.VERCEL_ENV !== 'production' &&
    env.VERCEL_ENV !== 'preview' &&
    env.NODE_ENV !== 'production'
  )
}

/**
 * Verify a Firebase ID token for the configured project and expose the claims used for
 * sign-in. `emulator` accepts the Auth emulator's unsigned tokens; callers set it only
 * when `authEmulatorEnabled` allows it.
 */
export async function verifyIdToken(
  token: string,
  deps: {
    projectId: string
    jwks: JWTVerifyGetKey
    now?: () => number
    emulator?: boolean
  }
): Promise<VerifiedIdentity | null> {
  try {
    const now = (deps.now ?? Date.now)()
    const claims = {
      issuer: `https://securetoken.google.com/${deps.projectId}`,
      audience: deps.projectId,
      currentDate: new Date(now),
      requiredClaims: ['exp', 'sub', 'auth_time'],
    }
    const payload: JWTPayload =
      deps.emulator && deps.projectId.startsWith('demo-')
        ? UnsecuredJWT.decode(token, claims).payload
        : (
            await jwtVerify(token, deps.jwks, {
              algorithms: ['RS256'],
              ...claims,
            })
          ).payload
    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      payload.sub.length > 128
    )
      return null
    if (
      typeof payload.auth_time !== 'number' ||
      !Number.isFinite(payload.auth_time) ||
      payload.auth_time > now / 1000
    )
      return null
    const firebase = payload.firebase
    const signInProvider =
      firebase &&
      typeof firebase === 'object' &&
      'sign_in_provider' in firebase &&
      typeof firebase.sign_in_provider === 'string'
        ? firebase.sign_in_provider
        : null
    return {
      uid: payload.sub,
      signInProvider,
      emailVerified: payload.email_verified === true,
      ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    }
  } catch {
    return null
  }
}

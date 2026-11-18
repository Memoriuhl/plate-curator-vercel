import { createRemoteJWKSet } from 'jose'

// Keep jose's key-set cache across token checks so each verification can reuse Google's keys.
const jwks = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  )
)

/** Reuse the remote Firebase signing-key lookup across token verifications. */
export function googleSecureTokenJwks() {
  return jwks
}

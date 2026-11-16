import { createRemoteJWKSet } from 'jose'

const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'))

export function googleSecureTokenJwks() {
  return jwks
}

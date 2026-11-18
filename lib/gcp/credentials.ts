import { getVercelOidcToken } from '@vercel/oidc'
import { ExternalAccountClient } from 'google-auth-library'
import { requireEnv } from '../env'

/**
 * Build the Google credentials client that exchanges Vercel OIDC identity for scoped
 * cloud access.
 */
export function gcpAuthClient() {
  const projectNumber = requireEnv('GCP_PROJECT_NUMBER')
  const poolId = requireEnv('GCP_WORKLOAD_IDENTITY_POOL_ID')
  const providerId = requireEnv('GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID')
  const serviceAccountEmail = requireEnv('GCP_SERVICE_ACCOUNT_EMAIL')

  const client = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    subject_token_supplier: { /** Provide a fresh Vercel OIDC subject token to the Google credentials exchange. */ getSubjectToken: () => getVercelOidcToken() },
  })
  if (!client) throw new Error('Could not build the Google credentials client')
  return client
}
import type { HostedModelBinding } from './selection'

export const STRICT_MODEL_FAILURE = 'strict_model_failed'
export const HOSTED_MODEL_FAILURE = 'hosted_model_failed'

export class HostedModelFailure extends Error {
  constructor(strict: boolean, cause?: unknown) {
    super(strict ? STRICT_MODEL_FAILURE : HOSTED_MODEL_FAILURE, { cause })
    this.name = 'HostedModelFailure'
  }
}

/** Suffix that makes AI Gateway answer `model_not_found` for a forced primary. */
export const FORCED_FAILURE_SUFFIX = '-forced-failure'

/**
 * Route a bound model through AI Gateway. Outside production,
 * FORCE_MODEL_FAILURE=<model id> sends that model under an id the Gateway
 * can't serve, so the Gateway's own fallback (or, in Strict mode, its error)
 * runs end to end instead of being simulated here.
 */
export function hostedModelRoute(model: string, binding?: HostedModelBinding) {
  const fallback = binding?.strict ? undefined : binding?.fallback?.model
  const forced = (id: string) =>
    !!binding &&
    process.env.VERCEL_ENV !== 'production' &&
    process.env.FORCE_MODEL_FAILURE === id
  return {
    model: forced(model) ? `${model}${FORCED_FAILURE_SUFFIX}` : model,
    ...(fallback
      ? {
          providerOptions: {
            gateway: {
              models: [
                forced(fallback)
                  ? `${fallback}${FORCED_FAILURE_SUFFIX}`
                  : fallback,
              ],
            },
          },
        }
      : {}),
  }
}

/** Return the canonical slug with a successful provider attempt in Gateway routing metadata. */
export function routedGatewayModel(metadata: unknown) {
  const attempts = (
    metadata as {
      gateway?: {
        routing?: {
          modelAttempts?: {
            canonicalSlug?: unknown
            providerAttempts?: { success?: unknown }[]
          }[]
        }
      }
    } | null
  )?.gateway?.routing?.modelAttempts
  if (!Array.isArray(attempts)) return undefined
  return attempts.find(
    (model) =>
      typeof model?.canonicalSlug === 'string' &&
      Array.isArray(model.providerAttempts) &&
      model.providerAttempts.some((provider) => provider?.success === true)
  )?.canonicalSlug as string | undefined
}

import type { HostedModelBinding } from './selection'

export const STRICT_MODEL_FAILURE = 'strict_model_failed'
export const HOSTED_MODEL_FAILURE = 'hosted_model_failed'

export class HostedModelFailure extends Error {
  constructor(strict: boolean, cause?: unknown) {
    super(strict ? STRICT_MODEL_FAILURE : HOSTED_MODEL_FAILURE, { cause })
    this.name = 'HostedModelFailure'
  }
}

export function hostedModelRoute(model: string, binding?: HostedModelBinding) {
  const fallback = binding?.strict ? undefined : binding?.fallback?.model
  const forced = (id: string) =>
    !!binding &&
    process.env.VERCEL_ENV !== 'production' &&
    process.env.FORCE_MODEL_FAILURE === id
  if (forced(model)) {
    if (!fallback) throw new HostedModelFailure(!!binding?.strict)
    return { model: fallback }
  }
  return {
    model,
    ...(fallback && !forced(fallback)
      ? { providerOptions: { gateway: { models: [fallback] } } }
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

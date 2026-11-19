import { connection } from 'next/server'
import { currentActor } from '../../../../lib/server/context'
import { allowedResearchModels } from '../../../../lib/research/models'
import { hostedModelCatalog } from '../../../../lib/jobs/model-binding'
import { json } from '../../../../lib/server/respond'

/**
 * List available research models and the default for the caller's deployment and role.
 */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const hosted =
    auth.actor.role === 'owner' &&
    process.env.RESEARCH_ENABLE_MODEL_CALLS === 'true'
      ? await hostedModelCatalog('research')
      : undefined
  const hostedChoices = hosted?.unavailable
    ? hosted.curated
    : hosted?.searchable
  const models = allowedResearchModels(
    !!hosted,
    auth.actor.role === 'owner'
  ).filter(
    (model) =>
      model.executor === 'desktop' ||
      hostedChoices?.some(({ id }) => id === model.model)
  )
  return json({ models, default: models[0]?.id, ...(hosted ? { hosted } : {}) })
}

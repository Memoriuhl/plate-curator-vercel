import { connection } from 'next/server'
import { currentActor, taggingModels } from '../../../../lib/server/context'
import { hostedModelCatalog } from '../../../../lib/jobs/model-binding'
import { chooseTaggingModel } from '../../../../lib/tagging/models'
import { json } from '../../../../lib/server/respond'

/** List available Tag models and the default for the signed-in curator. */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const enabled = taggingModels()
  const hosted =
    auth.actor.role === 'owner' &&
    enabled.some((model) => model.runsOn === 'gateway')
      ? await hostedModelCatalog('tag')
      : undefined
  const models = enabled.filter(
    (model) =>
      model.runsOn === 'desktop' ||
      hosted?.searchable.some(({ id }) => id === model.model)
  )
  const choice = chooseTaggingModel(
    undefined,
    models,
    process.env.TAGGING_DEFAULT_MODEL
  )
  return json({
    models: models.map(({ id, label, runsOn, measured }) => ({
      id,
      label,
      runsOn,
      measured,
    })),
    default: choice.ok ? choice.model.id : null,
    ...(hosted ? { hosted } : {}),
  })
}

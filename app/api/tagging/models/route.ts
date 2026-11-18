import { connection } from 'next/server'
import {
  chooseModel,
  currentActor,
  taggingModels,
} from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

/** List the enabled tagging models and the default selected by server configuration. */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const choice = chooseModel(undefined)
  return json({
    models: taggingModels().map(({ id, label, runsOn, measured }) => ({
      id,
      label,
      runsOn,
      measured,
    })),
    default: choice.ok ? choice.model.id : null,
  })
}

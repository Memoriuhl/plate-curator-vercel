import { connection } from 'next/server'
import { currentActor } from '../../../../lib/server/context'
import { allowedResearchModels } from '../../../../lib/research/models'
import { json } from '../../../../lib/server/respond'

/**
 * List available research models and the default for the caller's deployment and role.
 */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const models = allowedResearchModels(process.env.RESEARCH_ENABLE_MODEL_CALLS === 'true', auth.actor.role === 'owner')
  return json({ models, default: models[0]?.id })
}

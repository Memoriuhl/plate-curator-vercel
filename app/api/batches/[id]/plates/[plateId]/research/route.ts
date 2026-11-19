import { batchTarget } from '../../../../../../../lib/server/draft-target'
import { start } from 'workflow/api'
import { currentActiveOwner } from '@/lib/server/context'
import {
  readResearchJson,
  researchDeps,
  researchResponse,
} from '@/lib/server/research-context'
import { startResearch } from '@/lib/research/jobs'
import { researchRun } from '@/workflows/research'
import { HookConflictError } from 'workflow/errors'

/**
 * Authorize an owner research request and dispatch its workflow when the selected model
 * runs in Eve.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/plates/[plateId]/research'>
) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const body = await readResearchJson(request)
  if (
    !body ||
    !['desktop', 'eve'].includes(String(body.executor)) ||
    typeof body.requestKey !== 'string' ||
    (body.replaceJobId !== undefined && typeof body.replaceJobId !== 'string')
  )
    return Response.json({ error: 'bad_request' }, { status: 400 })
  const params = await ctx.params
  const plateId = params.plateId
  const id = await batchTarget(params.id, auth.actor)
  const result = await startResearch(await researchDeps(), auth.actor, {
    batchId: id,
    plateId,
    executor: body.executor as 'desktop' | 'eve',
    requestKey: body.requestKey,
    model: body.model,
    modelOptions: body.modelOptions,
    ...(typeof body.replaceJobId === 'string'
      ? { replaceJobId: body.replaceJobId }
      : {}),
  })
  if (
    result.ok &&
    result.value.executor === 'eve' &&
    result.value.state === 'queued'
  ) {
    try {
      await start(researchRun, [result.value.id], {
        experimental_hook: {
          token: `research-start:${result.value.id}`,
          experimental_minRetention: '7d',
        },
      })
    } catch (error) {
      if (!HookConflictError.is(error)) throw error
    }
  }
  return researchResponse(result, 202)
}

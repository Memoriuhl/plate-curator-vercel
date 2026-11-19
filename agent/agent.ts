import { defineAgent, defineDynamic } from 'eve'
import { gateway } from 'ai'
import { guardedResearchModel } from '../lib/research/model'
import { DEFAULT_HOSTED_RESEARCH_MODEL } from '../lib/research/models'
import { hostedModelRoute } from '../lib/models/routing'

export default defineAgent({
  defaultTools: false,
  reasoning: 'low',
  model: defineDynamic(async (ctx) => {
    const { researchTurn } = await import('../lib/research/runtime')
    const run = await researchTurn({
      session: { ...ctx.session, turn: { id: ctx.turn?.id ?? 'initial' } },
    })
    const model = run.binding?.model ?? DEFAULT_HOSTED_RESEARCH_MODEL
    if (model !== run.model)
      throw Error('Research model does not match the run binding')
    const route = hostedModelRoute(model, run.hostedModel)
    return {
      modelContextWindowTokens: 16384,
      model: guardedResearchModel(
        gateway(route.model),
        async () => {
          if (process.env.RESEARCH_ENABLE_MODEL_CALLS !== 'true')
            throw new Error(
              'Research model calls are disabled. Configure the authorized pilot before enabling RESEARCH_ENABLE_MODEL_CALLS.'
            )
          return run.modelAttempt()
        },
        !!run.binding?.pipelineJobId,
        run.hostedModel
          ? {
              gatewayOptions: route.providerOptions?.gateway,
              strict: run.hostedModel.strict,
            }
          : undefined
      ),
    }
  }),
  limits: {
    /** Flag research sessions approaching the usage threshold so the agent can manage context and spend. */ sessionUsage:
      ({ total }) =>
        total.inputTokens - total.cacheReadTokens >= 50000 ||
        total.outputTokens >= 10000 ||
        (total.costUsd ?? 0) >= 0.1,
  },
})

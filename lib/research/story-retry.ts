import { generateText, gateway, tool } from 'ai'
import type { ModelPriceSnapshot } from '../models/selection'
import { reportedGatewayCost } from './cost'
import { createResearchModelAttempt } from './models/model-attempt'
import type { ResearchStateStore } from './state'
import type { EvidenceSource, ResearchDraft, ResearchRejection } from './types'
import { researchDraftSchema, validateResearchResult } from './validate'

/** The first draft's single call plus this one retry. */
export const pipelineResearchMaxCalls = 2

export type StoryRetryInput = {
  jobId: string
  model: string
  price: ModelPriceSnapshot
  deadline: number
  prompt: string
  sources: EvidenceSource[]
}
export type StoryRetry = (
  input: StoryRetryInput
) => Promise<{ draft: ResearchDraft; rejected: ResearchRejection[] } | null>

/**
 * Ask the same model once more, directly through AI Gateway, when the first draft came
 * back without the description or story it was asked for. The model often returns an
 * empty draft for evidence it can cite on the next call. The attempt counts against the
 * job's call limit and the research budget, so a replayed workflow step cannot retry
 * twice. Any failure keeps the first draft.
 */
export function gatewayStoryRetry(state: ResearchStateStore): StoryRetry {
  return async ({ jobId, model, price, deadline, prompt, sources }) => {
    let attempt: Awaited<ReturnType<typeof createResearchModelAttempt>>
    try {
      attempt = await createResearchModelAttempt(state, jobId, {
        campaign: process.env.RESEARCH_BUDGET_ID ?? 'eve-research-1117',
        limitUsd: Number(process.env.RESEARCH_BUDGET_USD ?? '2'),
        deadline,
        ...price,
        maxCalls: pipelineResearchMaxCalls,
      })
    } catch {
      return null
    }
    try {
      const response = await generateText({
        model: gateway(model),
        maxRetries: 0,
        tools: {
          submit_draft: tool({
            description: 'Submit the source-grounded research draft.',
            inputSchema: researchDraftSchema,
          }),
        },
        toolChoice: { type: 'tool', toolName: 'submit_draft' },
        prompt,
      })
      await attempt.settle(reportedGatewayCost(response.providerMetadata))
      return validateResearchResult(response.toolCalls[0]?.input, sources)
    } catch {
      await attempt.settle(undefined)
      return null
    }
  }
}

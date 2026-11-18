import { wrapLanguageModel } from 'ai'
import { reportedGatewayCost } from './cost'
type Attempt = { settle(costUsd: number | undefined, usage?: Record<string, number>): Promise<void> }

/** Normalize provider token counts to valid nonnegative usage fields for reporting. */
function tokenUsage(usage: unknown): Record<string, number> {
  const data = usage as { inputTokens?: { total?: number }; outputTokens?: { total?: number } }
  return Object.fromEntries(Object.entries({ inputTokens: data?.inputTokens?.total, outputTokens: data?.outputTokens?.total }).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0))
}

/**
 * Wrap a research model with request size, token and spend controls for generation and
 * streaming.
 */
export function guardedResearchModel(model: Parameters<typeof wrapLanguageModel>[0]['model'], beforeRequest: () => Promise<void | Attempt>, capturedOnly = false) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      /**
       * Validate request size and cap model output so the turn stays within configured
       * limits.
       */
      async transformParams({ params }) {
        if (Buffer.byteLength(JSON.stringify(params)) > 60000) throw new Error('Research context exceeds the pilot input bound')
        const submit = capturedOnly ? params.tools?.find(tool => tool.type === 'function' && tool.name === 'submit_draft') : undefined
        if (capturedOnly && !submit) throw Error('Research requires the structured submit_draft tool')
        return { ...params, maxOutputTokens: Math.min(params.maxOutputTokens ?? 1000, 1000), ...(submit ? { tools: [submit], toolChoice: { type: 'tool' as const, toolName: submit.name } } : {}) }
      },
      /** Reserve and settle one budgeted attempt around a complete model response. */
      async wrapGenerate({ doGenerate }) {
        const attempt = await beforeRequest()
        const result = await doGenerate()
        await attempt?.settle(reportedGatewayCost(result.providerMetadata), tokenUsage(result.usage))
        return result
      },
      /**
       * Reserve a streaming attempt and settle usage when the provider reports
       * completion.
       */
      async wrapStream({ doStream }) {
        const attempt = await beforeRequest()
        const result = await doStream()
        if (!attempt) return result
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({
          /**
           * Settle the streamed attempt on its finish event and forward every part to
           * the consumer.
           */
          async transform(part, controller) {
            if (part.type === 'finish') await attempt.settle(reportedGatewayCost(part.providerMetadata), tokenUsage(part.usage))
            controller.enqueue(part)
          },
        })) }
      },
    },
  })
}

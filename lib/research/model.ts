import { wrapLanguageModel } from 'ai'
import { reportedGatewayCost } from './cost'
type Attempt = { settle(costUsd: number | undefined): Promise<void> }

export function guardedResearchModel(model: Parameters<typeof wrapLanguageModel>[0]['model'], beforeRequest: () => Promise<void | Attempt>) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      async transformParams({ params }) {
        if (Buffer.byteLength(JSON.stringify(params)) > 60000) throw new Error('Research context exceeds the pilot input bound')
        return { ...params, maxOutputTokens: Math.min(params.maxOutputTokens ?? 1000, 1000) }
      },
      async wrapGenerate({ doGenerate }) {
        const attempt = await beforeRequest()
        const result = await doGenerate()
        await attempt?.settle(reportedGatewayCost(result.providerMetadata))
        return result
      },
      async wrapStream({ doStream }) {
        const attempt = await beforeRequest()
        const result = await doStream()
        if (!attempt) return result
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({
          async transform(part, controller) {
            if (part.type === 'finish') await attempt.settle(reportedGatewayCost(part.providerMetadata))
            controller.enqueue(part)
          },
        })) }
      },
    },
  })
}

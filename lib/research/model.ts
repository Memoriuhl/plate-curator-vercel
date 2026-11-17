import { wrapLanguageModel } from 'ai'

export function guardedResearchModel(model: Parameters<typeof wrapLanguageModel>[0]['model'], beforeRequest: () => Promise<void>) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      async transformParams({ params }) {
        if (Buffer.byteLength(JSON.stringify(params)) > 60000) throw new Error('Research context exceeds the pilot input bound')
        return { ...params, maxOutputTokens: Math.min(params.maxOutputTokens ?? 1000, 1000) }
      },
      async wrapGenerate({ doGenerate }) { await beforeRequest(); return doGenerate() },
      async wrapStream({ doStream }) { await beforeRequest(); return doStream() },
    },
  })
}

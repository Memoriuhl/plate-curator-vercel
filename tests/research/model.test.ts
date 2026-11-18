import { expect, test } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { guardedResearchModel } from '../../lib/research/model'

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Research a plate' }] }]
const response = { content: [{ type: 'text' as const, text: 'ok' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }

test('the budget gate runs before every physical model attempt and bounds output', async () => {
  const upstream = new MockLanguageModelV4({ doGenerate: response })
  let attempts = 0
  const model = guardedResearchModel(upstream, async () => { if (++attempts > 1) throw new Error('budget exhausted') })
  await model.doGenerate({ prompt, maxOutputTokens: 8000 })
  await expect(model.doGenerate({ prompt })).rejects.toThrow('budget exhausted')
  expect(upstream.doGenerateCalls).toHaveLength(1)
  expect(upstream.doGenerateCalls[0].maxOutputTokens).toBe(1000)
})

test('tool definitions count toward the request input bound before any charged call', async () => {
  const upstream = new MockLanguageModelV4({ doGenerate: response })
  const model = guardedResearchModel(upstream, async () => undefined)
  await expect(model.doGenerate({ prompt, tools: [{ type: 'function', name: 'large_tool', description: 'x'.repeat(65000), inputSchema: { type: 'object', properties: {} } }] })).rejects.toThrow('input bound')
  expect(upstream.doGenerateCalls).toHaveLength(0)
})

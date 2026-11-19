import { expect, test } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { guardedResearchModel } from '../../lib/research/models/model'

const prompt = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Research a plate' }],
  },
]
const response = {
  content: [{ type: 'text' as const, text: 'ok' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
}

test('the budget gate runs before every physical model attempt and bounds output', async () => {
  const upstream = new MockLanguageModelV4({ doGenerate: response })
  let attempts = 0
  const model = guardedResearchModel(upstream, async () => {
    if (++attempts > 1) throw new Error('budget exhausted')
  })
  await model.doGenerate({ prompt, maxOutputTokens: 8000 })
  await expect(model.doGenerate({ prompt })).rejects.toThrow('budget exhausted')
  expect(upstream.doGenerateCalls).toHaveLength(1)
  expect(upstream.doGenerateCalls[0].maxOutputTokens).toBe(1000)
})

test('tool definitions count toward the request input bound before any charged call', async () => {
  const upstream = new MockLanguageModelV4({ doGenerate: response })
  const model = guardedResearchModel(upstream, async () => undefined)
  await expect(
    model.doGenerate({
      prompt,
      tools: [
        {
          type: 'function',
          name: 'large_tool',
          description: 'x'.repeat(65000),
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })
  ).rejects.toThrow('input bound')
  expect(upstream.doGenerateCalls).toHaveLength(0)
})

test('captured research exposes only submit_draft, forces structured completion and records actual usage', async () => {
  const upstream = new MockLanguageModelV4({ doGenerate: response })
  const settled: unknown[] = []
  const model = guardedResearchModel(
    upstream,
    async () => ({
      /** Capture model attempt settlement so the test can inspect cost and usage accounting. */ settle:
        async (cost, usage) => {
          settled.push({ cost, usage })
        },
    }),
    true
  )
  await model.doGenerate({
    prompt,
    reasoning: 'low',
    tools: [
      { type: 'function', name: 'search_web', inputSchema: { type: 'object' } },
      {
        type: 'function',
        name: 'submit_draft',
        inputSchema: { type: 'object' },
      },
    ],
  })
  expect(
    upstream.doGenerateCalls[0].tools?.map(
      (tool) => tool.type === 'function' && tool.name
    )
  ).toEqual(['submit_draft'])
  expect(upstream.doGenerateCalls[0].reasoning).toBe('none')
  expect(upstream.doGenerateCalls[0].toolChoice).toEqual({
    type: 'tool',
    toolName: 'submit_draft',
  })
  expect(settled).toEqual([
    { cost: undefined, usage: { inputTokens: 1, outputTokens: 1 } },
  ])
})

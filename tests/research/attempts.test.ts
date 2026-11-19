import { expect, test } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createResearchMemoryState } from '../../lib/research/state'
import { guardedResearchModel } from '../../lib/research/model'
import {
  createResearchModelAttempt,
  researchModelCosts,
} from '../../lib/research/model-attempt'

const prompt = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Research' }],
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

test('mixed known, unreported, and failed physical attempts retain unknown reservations', async () => {
  const state = createResearchMemoryState()
  let calls = 0
  const upstream = new MockLanguageModelV4({
    /** Return controlled model attempts with a third-call failure to exercise attempt accounting. */ doGenerate:
      async () => {
        calls++
        if (calls === 3) throw new Error('network failure')
        return {
          ...response,
          ...(calls === 1
            ? { providerMetadata: { gateway: { cost: '0.01' } } }
            : {}),
        }
      },
  })
  const model = guardedResearchModel(upstream, () =>
    createResearchModelAttempt(state, 'run', {
      campaign: 'campaign',
      limitUsd: 2,
      price: { input: 0.0000001, output: 0.0000004 },
      deadline: Date.now() + 10000,
    })
  )
  await model.doGenerate({ prompt })
  await model.doGenerate({ prompt })
  await expect(model.doGenerate({ prompt })).rejects.toThrow('network failure')
  expect(await state.read('budget/campaign')).toMatchObject({
    committedMicros: 22800,
  })
  expect(await researchModelCosts(state, 'run')).toEqual({
    costUsd: 0.01,
    missingModelCosts: 2,
    modelAttempts: 3,
  })
})

test('stream settlement uses each finish metadata entry instead of an aggregate', async () => {
  const state = createResearchMemoryState()
  const upstream = new MockLanguageModelV4({
    /** Simulate a successful streamed model response with controlled completion metadata. */ doStream:
      async () => ({
        stream: new ReadableStream({
          /** Emit a finish event with known Gateway cost so stream settlement can be checked. */ start(
            controller
          ) {
            controller.enqueue({
              type: 'finish',
              finishReason: response.finishReason,
              usage: response.usage,
              providerMetadata: { gateway: { cost: '0.012' } },
            })
            controller.close()
          },
        }),
      }),
  })
  const model = guardedResearchModel(upstream, () =>
    createResearchModelAttempt(state, 'stream', {
      campaign: 'campaign',
      limitUsd: 2,
      price: { input: 0.0000001, output: 0.0000004 },
      deadline: Date.now() + 10000,
    })
  )
  const result = await model.doStream({ prompt })
  const reader = result.stream.getReader()
  while (!(await reader.read()).done) {}
  expect(await state.read('budget/campaign')).toMatchObject({
    committedMicros: 12000,
  })
  expect(await researchModelCosts(state, 'stream')).toMatchObject({
    costUsd: 0.012,
    missingModelCosts: 0,
  })
})

test('stream settlement records the model that answered after a Gateway error fallback', async () => {
  const settled: unknown[][] = []
  const upstream = new MockLanguageModelV4({
    modelId: 'openai/test-tool',
    /** Live Gateway shape (probed 2026-11-18): response metadata echoes the requested model. */ doStream:
      async () => ({
        stream: new ReadableStream({
          /** Emit the requested model id, then a finish whose routing shows the fallback answered. */ start(
            controller
          ) {
            controller.enqueue({
              type: 'response-metadata',
              modelId: 'openai/test-tool',
            })
            controller.enqueue({
              type: 'finish',
              finishReason: response.finishReason,
              usage: response.usage,
              providerMetadata: {
                gateway: {
                  routing: {
                    modelAttempts: [
                      {
                        canonicalSlug: 'openai/test-tool',
                        providerAttempts: [{ success: false }],
                      },
                      {
                        canonicalSlug: 'google/gemini-2.5-flash-lite',
                        providerAttempts: [{ success: true }],
                      },
                    ],
                  },
                },
              },
            })
            controller.close()
          },
        }),
      }),
  })
  const model = guardedResearchModel(upstream, async () => ({
    async settle(...args: unknown[]) {
      settled.push(args)
    },
  }))
  const result = await model.doStream({ prompt })
  const reader = result.stream.getReader()
  while (!(await reader.read()).done) {}
  expect(settled).toHaveLength(1)
  expect(settled[0][2]).toBe('google/gemini-2.5-flash-lite')
})

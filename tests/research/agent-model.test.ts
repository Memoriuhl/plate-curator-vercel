import { afterEach, expect, test, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import researchAgent from '../../agent/agent'

const mocks = vi.hoisted(() => ({ researchTurn: vi.fn(), gateway: vi.fn() }))
vi.mock('eve', () => ({
  defineAgent: (config: unknown) => config,
  defineDynamic: (resolve: unknown) => ({ resolve }),
}))
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  gateway: mocks.gateway,
}))
vi.mock('../../lib/research/runtime', () => ({
  researchTurn: mocks.researchTurn,
}))

afterEach(() => vi.unstubAllEnvs())

test.each([
  'google/gemini-2.5-flash-lite',
  'google/gemma-4-26b-a4b-it',
  'openai/test-tool',
])(
  'Eve uses the queued model %s for the guarded submit_draft call',
  async (modelId) => {
    vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
    const modelAttempt = vi.fn()
    mocks.researchTurn.mockResolvedValue({
      binding: { pipelineJobId: 'job', model: modelId },
      model: modelId,
      modelAttempt,
    })
    const upstream = new MockLanguageModelV4({
      modelId,
      doGenerate: {
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      },
    })
    mocks.gateway.mockReturnValue(upstream)

    expect(researchAgent.defaultTools).toBe(false)
    const { resolve } = researchAgent.model as unknown as {
      resolve(context: {
        session: { id: string }
        turn: { id: string }
      }): Promise<{ model: MockLanguageModelV4 }>
    }
    const { model } = await resolve({
      session: { id: 'session' },
      turn: { id: 'turn' },
    })
    expect(mocks.gateway).toHaveBeenLastCalledWith(modelId)
    await model.doGenerate({
      prompt: [],
      tools: [
        {
          type: 'function',
          name: 'submit_draft',
          inputSchema: { type: 'object' },
        },
      ],
    })
    expect(modelAttempt).toHaveBeenCalledTimes(1)
    expect(upstream.doGenerateCalls).toMatchObject([
      { toolChoice: { type: 'tool', toolName: 'submit_draft' } },
    ])
  }
)

test('Eve refuses a session model that differs from the stored run model', async () => {
  mocks.researchTurn.mockResolvedValue({
    binding: { pipelineJobId: 'job', model: 'google/gemma-4-26b-a4b-it' },
    model: 'google/gemini-2.5-flash-lite',
  })
  mocks.gateway.mockClear()
  const { resolve } = researchAgent.model as unknown as {
    resolve(context: {
      session: { id: string }
      turn: { id: string }
    }): Promise<unknown>
  }
  await expect(
    resolve({ session: { id: 'session' }, turn: { id: 'turn' } })
  ).rejects.toThrow('Research model does not match the run binding')
  expect(mocks.gateway).not.toHaveBeenCalled()
})

test.each([
  { env: 'preview', strict: false, expected: 'google/gemini-2.5-flash-lite' },
  { env: 'preview', strict: true, expected: null },
  { env: 'production', strict: false, expected: 'openai/test-tool' },
])(
  'simulates a failed Research primary only outside production ($env, strict $strict)',
  async ({ env, strict, expected }) => {
    vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
    vi.stubEnv('FORCE_MODEL_FAILURE', 'openai/test-tool')
    vi.stubEnv('VERCEL_ENV', env)
    const model = 'openai/test-tool'
    const fallback = {
      model: 'google/gemini-2.5-flash-lite',
      price: { input: 0.0000001, output: 0.0000004 },
    }
    const settle = vi.fn()
    mocks.researchTurn.mockResolvedValue({
      binding: { jobId: 'job', model },
      model,
      hostedModel: {
        model,
        strict,
        capUsd: 0.01,
        price: fallback.price,
        ...(strict ? {} : { fallback }),
      },
      modelAttempt: async () => ({ settle }),
    })
    const upstream = new MockLanguageModelV4({
      modelId: expected ?? model,
      doGenerate: {
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        providerMetadata: {
          gateway: {
            routing: {
              modelAttempts: [
                {
                  canonicalSlug: fallback.model,
                  providerAttempts: [{ success: true }],
                },
              ],
            },
          },
        },
      },
    })
    mocks.gateway.mockClear().mockReturnValue(upstream)
    const { resolve } = researchAgent.model as unknown as {
      resolve(context: {
        session: { id: string }
        turn: { id: string }
      }): Promise<{ model: MockLanguageModelV4 }>
    }
    const result = resolve({ session: { id: 'session' }, turn: { id: 'turn' } })
    if (!expected) {
      await expect(result).rejects.toThrow('strict_model_failed')
      expect(mocks.gateway).not.toHaveBeenCalled()
      return
    }
    await (await result).model.doGenerate({ prompt: [] })
    expect(mocks.gateway).toHaveBeenCalledWith(expected)
    expect(
      upstream.doGenerateCalls[0].providerOptions?.gateway?.models
    ).toEqual(env === 'production' ? [fallback.model] : undefined)
    expect(settle).toHaveBeenCalledWith(
      undefined,
      { inputTokens: 1, outputTokens: 1 },
      fallback.model
    )
  }
)

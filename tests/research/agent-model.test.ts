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
  // Preview: the fault switch sends an id the Gateway can't serve, so the
  // Gateway's own fallback answers.
  {
    env: 'preview',
    strict: false,
    requested: 'openai/test-tool-forced-failure',
    fallbackList: ['google/gemini-2.5-flash-lite'],
  },
  // Preview Strict: no fallback list, so the Gateway's model_not_found
  // becomes the named Strict failure.
  {
    env: 'preview',
    strict: true,
    requested: 'openai/test-tool-forced-failure',
    fallbackList: undefined,
  },
  // Production ignores the switch; a real primary failure still falls back.
  {
    env: 'production',
    strict: false,
    requested: 'openai/test-tool',
    fallbackList: ['google/gemini-2.5-flash-lite'],
  },
])(
  'routes a failed Research primary through the Gateway ($env, strict $strict)',
  async ({ env, strict, requested, fallbackList }) => {
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
      modelId: requested,
      doGenerate: strict
        ? async () => {
            throw new Error(`Model '${requested}' not found`)
          }
        : {
            content: [],
            finishReason: { unified: 'stop', raw: 'stop' },
            warnings: [],
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            // Live Gateway shape (probed 2026-11-18): on an error fallback,
            // response.modelId echoes the requested model and only the
            // routing attempts show which model answered.
            response: { modelId: requested },
            providerMetadata: {
              gateway: {
                routing: {
                  modelAttempts: [
                    {
                      canonicalSlug: requested,
                      providerAttempts: [{ success: false }],
                    },
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
    const resolved = await resolve({
      session: { id: 'session' },
      turn: { id: 'turn' },
    })
    expect(mocks.gateway).toHaveBeenCalledWith(requested)
    const call = resolved.model.doGenerate({ prompt: [] })
    if (strict) {
      await expect(call).rejects.toThrow('strict_model_failed')
      expect(settle).not.toHaveBeenCalled()
    } else {
      await call
      expect(settle).toHaveBeenCalledWith(
        undefined,
        { inputTokens: 1, outputTokens: 1 },
        fallback.model
      )
    }
    expect(
      upstream.doGenerateCalls[0].providerOptions?.gateway?.models
    ).toEqual(fallbackList)
  }
)

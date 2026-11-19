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

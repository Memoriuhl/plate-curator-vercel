import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GET } from '../../app/api/research/models/route'
import { GET as tagModels } from '../../app/api/tagging/models/route'
import { installModelCatalogFixture } from '../models/fixture'
import { enabledTaggingModels } from '../../lib/tagging/models'

installModelCatalogFixture()

const mocks = vi.hoisted(() => ({ connection: vi.fn(), actor: vi.fn() }))
vi.mock('next/server', () => ({ connection: mocks.connection }))
vi.mock('../../lib/server/context', () => ({
  currentActor: mocks.actor,
  taggingModels: () => enabledTaggingModels(process.env.TAGGING_MODELS),
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connection.mockResolvedValue(undefined)
  mocks.actor.mockResolvedValue({
    ok: true,
    actor: { uid: 'owner', role: 'owner' },
  })
  vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
})
afterEach(() => vi.unstubAllEnvs())

test('model discovery waits for a live request before reading authenticated runtime configuration', async () => {
  mocks.connection.mockRejectedValue(Error('Prerender has no request'))
  await expect(
    GET(new Request('https://example.com/api/research/models'))
  ).rejects.toThrow('Prerender has no request')
  expect(mocks.actor).not.toHaveBeenCalled()
})

test.each([
  ['owner', 'true', true],
  ['editor', 'true', false],
  ['owner', 'false', false],
])(
  'model discovery for %s with calls %s returns only permitted choices',
  async (role, enabled, hosted) => {
    mocks.actor.mockResolvedValue({ ok: true, actor: { uid: 'member', role } })
    vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', enabled)
    const response = await GET(
      new Request('https://example.com/api/research/models')
    )
    const result = await response.json()
    expect(
      result.models.filter(
        (model: { executor: string }) => model.executor === 'eve'
      )
    ).toEqual(
      hosted
        ? [
            {
              id: 'eve-gemini-2-5-flash-lite',
              label: 'Gemini 2.5 Flash Lite',
              executor: 'eve',
              model: 'google/gemini-2.5-flash-lite',
            },
            {
              id: 'eve-gemma4-26b',
              label: 'Gemma 4 26B',
              executor: 'eve',
              model: 'google/gemma-4-26b-a4b-it',
            },
          ]
        : []
    )
    expect(result.default).toBe('desktop-gemma4-12b')
    expect(response.headers.get('cache-control')).toContain('no-store')
  }
)

test('unauthenticated model discovery preserves the authentication refusal', async () => {
  mocks.actor.mockResolvedValue({
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
  })
  expect(
    (await GET(new Request('https://example.com/api/research/models'))).status
  ).toBe(401)
})

test.each([
  [GET, 'openai/test-tool', 'google/gemini-2.5-flash-lite'],
  [tagModels, 'openai/test-vision', 'google/gemma-4-26b-a4b-it'],
])(
  'lists live curated and searchable models only for Owners and under the max preset',
  async (list, extra, curated) => {
    vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b,gateway-gemma4-26b')
    vi.stubEnv('HOSTED_MODEL_MAX_USD_PER_PLATE', '0.005')
    const request = new Request('https://example.com/api/models')
    const result = await (await list(request)).json()
    expect(result.hosted).toMatchObject({
      caps: [0.002, 0.005],
      curated: expect.arrayContaining([
        expect.objectContaining({ id: curated }),
      ]),
      searchable: expect.arrayContaining([
        expect.objectContaining({ id: extra }),
      ]),
    })
    mocks.actor.mockResolvedValue({
      ok: true,
      actor: { uid: 'editor', role: 'editor' },
    })
    const editor = await (await list(request)).json()
    expect(editor.hosted).toBeUndefined()
    expect(
      editor.models.every(
        (model: { runsOn?: string; executor?: string }) =>
          (model.runsOn ?? model.executor) === 'desktop'
      )
    ).toBe(true)
  }
)

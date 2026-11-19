import { beforeEach, afterEach, vi } from 'vitest'

const catalog = {
  data: [
    [
      'google/gemini-2.5-flash-lite',
      'Gemini 2.5 Flash Lite',
      ['vision', 'tool-use', 'reasoning'],
      '0.0000001',
    ],
    [
      'google/gemma-4-26b-a4b-it',
      'Gemma 4 26B',
      ['vision', 'tool-use', 'reasoning'],
      '0.00000015',
    ],
    ['openai/test-vision', 'Test Vision', ['vision'], '0.0000002'],
    ['openai/test-tool', 'Test Tool', ['tool-use'], '0.0000002'],
  ].map(([id, name, tags, input]) => ({
    id,
    name,
    type: 'language',
    owned_by: String(id).split('/')[0],
    tags,
    pricing: { input, output: '0.0000004' },
  })),
}

export function installModelCatalogFixture() {
  beforeEach(() => {
    const original = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === 'https://ai-gateway.vercel.sh/v1/models')
          return Response.json(catalog)
        return original(input, init)
      }
    )
  })
  afterEach(() => vi.unstubAllGlobals())
}

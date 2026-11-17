import { afterEach, expect, test, vi } from 'vitest'
import { findWikipediaLink } from '../../worker/pipeline/wiki'
import { createColorStageHandler } from '../../worker/pipeline/colors'

afterEach(() => vi.unstubAllEnvs())

test('Wiki link selects a relevant Wikipedia search hit without any model request', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ query: { search: [{ title: 'Wildlife (film)' }, { title: 'Rocky Mountain Elk Foundation' }] } }))
  const result = await findWikipediaLink({ displayName: 'Rocky Mountain Elk Foundation', state: 'MD', image: '', tags: [] }, fetch)
  expect(result.fieldSuggestion?.fields).toEqual({ wikiUrl: 'https://en.wikipedia.org/wiki/Rocky_Mountain_Elk_Foundation' })
  expect(result.fieldSuggestion?.sources).toEqual(['https://en.wikipedia.org/wiki/Rocky_Mountain_Elk_Foundation'])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/en.wikipedia.org\/w\/api.php/)
})

test('Wiki link does not mistake a generic shared subject word for the named organization', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ query: { search: [{ title: 'Blackwater National Wildlife Refuge' }] } }))
    .mockResolvedValueOnce(Response.json({ query: { pages: [{ title: 'Vehicle registration plates of Maryland' }] } }))
  const result = await findWikipediaLink({ displayName: 'Wildlife Forever', state: 'MD', image: '', tags: [] }, fetch)
  expect(result.fieldSuggestion?.fields.wikiUrl).toBe('https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Maryland')
})

test('Colors proposes legacy color fields and text-color tags while preserving unrelated tags', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ message: { content: JSON.stringify({ primaryColor: 'white', textColors: ['black', 'invalid'], colors: ['white'], subjects: [], themes: [], motifs: [] }) } }))
  const readImage = vi.fn(async () => 'base64')
  const result = await createColorStageHandler({ url: 'http://localhost:11434', fetch, readImage })({ stage: 'colors', model: 'gemma4:12b', plate: { displayName: 'One', state: 'MD', image: 'MD/one.webp', tags: ['wildlife', 'blue text'] } })
  expect(result.fieldSuggestion?.fields).toEqual({ colorDetail: 'white', lineageColor: 'white', tags: ['wildlife', 'black text'] })
  expect(readImage).toHaveBeenCalledWith('MD/one.webp')
})

test('missing local images return an explicit result without model inference', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>()
  const handler = createColorStageHandler({ url: 'http://localhost:11434', fetch, readImage: async () => { throw Object.assign(Error('Missing'), { code: 'ENOENT' }) } })
  expect(await handler({ stage: 'colors', plate: { displayName: 'One', state: 'MD', image: 'missing.webp', tags: [] } })).toMatchObject({ stageError: 'missing_image' })
  expect(fetch).not.toHaveBeenCalled()
})

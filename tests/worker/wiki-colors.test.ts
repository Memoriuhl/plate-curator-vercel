import { afterEach, expect, test, vi } from 'vitest'
import { findWikipediaLink } from '../../worker/pipeline/wiki'
import { createColorStageHandler } from '../../worker/pipeline/colors'
import type { StageResult } from '../../worker/run'

function suggestedFields(result: StageResult) {
  expect(result.fieldSuggestion?.kind).toBe('fields')
  return result.fieldSuggestion?.kind === 'fields' ? result.fieldSuggestion.fields : undefined
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

test('Wiki link selects a relevant Wikipedia search hit without any model request', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ query: { search: [{ title: 'Wildlife (film)' }, { title: 'Rocky Mountain Elk Foundation' }] } }))
  const result = await findWikipediaLink({ displayName: 'Rocky Mountain Elk Foundation', state: 'MD', image: '', tags: [] }, fetch)
  expect(suggestedFields(result)).toEqual({ wikiUrl: 'https://en.wikipedia.org/wiki/Rocky_Mountain_Elk_Foundation' })
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
  expect(suggestedFields(result)?.wikiUrl).toBe('https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Maryland')
})

test('Colors proposes legacy color fields and text-color tags while preserving unrelated tags', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ message: { content: JSON.stringify({ primaryColor: 'white', textColors: ['black', 'invalid'], colors: ['white'], subjects: [], themes: [], motifs: [] }) } }))
  const readImage = vi.fn(async () => 'base64')
  const result = await createColorStageHandler({ url: 'http://localhost:11434', fetch, readImage })({ stage: 'colors', model: 'gemma4:12b', plate: { displayName: 'One', state: 'MD', image: 'MD/one.webp', tags: ['wildlife', 'blue text'] } })
  expect(suggestedFields(result)).toEqual({ colorDetail: 'white', lineageColor: 'white', tags: ['wildlife', 'black text'] })
  expect(readImage).toHaveBeenCalledWith('MD/one.webp')
})

test('missing local images return an explicit result without model inference', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>()
  const handler = createColorStageHandler({ url: 'http://localhost:11434', fetch, readImage: async () => { throw Object.assign(Error('Missing'), { code: 'ENOENT' }) } })
  expect(await handler({ stage: 'colors', plate: { displayName: 'One', state: 'MD', image: 'missing.webp', tags: [] } })).toMatchObject({ stageError: 'missing_image' })
  expect(fetch).not.toHaveBeenCalled()
})

test('Colors retries share one inference deadline and never restart it', async () => {
  vi.useFakeTimers()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const began = Date.now()
  const signals: AbortSignal[] = []
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    const signal = init!.signal!
    signals.push(signal)
    if (signals.length === 1) return new Promise(resolve => setTimeout(() => resolve(new Response('', { status: 500 })), 90000))
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const settled = createColorStageHandler({ url: 'http://localhost:11434', fetch, readImage: async () => 'base64' })({ stage: 'colors', plate: { displayName: 'One', state: 'MD', image: 'one.webp', tags: [] } }).catch(error => error)
  await vi.advanceTimersByTimeAsync(121200)
  expect(await settled).toMatchObject({ message: 'Local Colors inference deadline exceeded' })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(signals[0]).toBe(signals[1])
  expect(signals[1].aborted).toBe(true)
  expect(Date.now() - began).toBeLessThan(125000)
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['https://upload.wikimedia.org/example.webp', '', null])('Colors prefers a projected image URL and keeps provenance unchanged: %s', async imageUrl => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ message: { content: JSON.stringify({ primaryColor: 'white', textColors: [] }) } }))
  const readImage = vi.fn(async () => 'base64')
  const plate = { displayName: 'One', state: 'MD', image: 'MD/one.webp', imageUrl, sourceUrl: 'https://example.org/image-provenance', tags: [] }
  const result = await createColorStageHandler({ url: 'http://localhost:11434', fetch, readImage })({ stage: 'colors', plate })
  expect(readImage).toHaveBeenCalledWith(imageUrl || plate.image)
  expect(suggestedFields(result)).not.toHaveProperty('sourceUrl')
  expect(plate.sourceUrl).toBe('https://example.org/image-provenance')
})



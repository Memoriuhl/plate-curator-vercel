import { expect, test, vi } from 'vitest'
import { gatherWikipedia, relevantText, wikipediaText } from '../../worker/pipeline/sources'

test('Wikipedia extraction retains table-row context while stripping scripts, styles and reference noise', () => {
  expect(wikipediaText('<style>hidden</style><script>hidden()</script><table><tr><td>Army &amp; Navy</td><td>Issued&#x20;in 1976<sup>1</sup></td></tr></table>')).toEqual(['Army & Navy · Issued in 1976 ·'])
  expect(relevantText(['Unrelated text.', 'Gold plates support wildlife.', 'More unrelated text.'], 'Standard Gold')).toBe('Gold plates support wildlife.')
})

test('source gathering only fetches the fixed Wikipedia API and ignores unrelated film/search hits', async () => {
  const request = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://en.wikipedia.org')
    if (url.searchParams.get('list') === 'search') return Response.json({ query: { search: [{ title: 'Wildlife (film)' }, { title: 'Alaska Wildlife' }, { title: 'Vehicle registration plate' }] } })
    if (url.searchParams.get('prop') === 'extracts') return Response.json({ query: { pages: [{ title: url.searchParams.get('titles'), extract: 'Wildlife registration fees support habitat conservation and wildlife education programs throughout the state of Alaska.' }] } })
    return Response.json({ parse: { title: url.searchParams.get('page'), text: '<p>Wildlife registration fees support habitat conservation and wildlife education programs throughout the state of Alaska.</p>' } })
  })
  const result = await gatherWikipedia({ displayName: 'Wildlife', state: 'AK', image: '', tags: [], wikiUrl: 'https://unrelated.example/wiki/Secret', sourceUrl: 'http://unrelated.example' }, request)
  expect(result.map(source => source.title)).toEqual(['Vehicle registration plates of Alaska', 'Alaska Wildlife'])
  expect(result.map(source => source.id)).toEqual(['S1', 'S2'])
  expect(request).toHaveBeenCalledTimes(3)
})

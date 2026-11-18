import { parse } from 'node-html-parser'
import { fetchResearchPage } from '../../lib/research/fetch-page'
import type { EvidenceSource } from '../../lib/research/types'
import type { WorkerPlate } from '../run'

const directory = 'https://dmv.alaska.gov/vehicle-services/license-plates/'
type PlateReference = Pick<
  WorkerPlate,
  'state' | 'displayName' | 'sourceUrl' | 'wikiUrl'
>
const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export async function captureAlaskaPlateSources(
  plate: PlateReference,
  fetchPage = fetchResearchPage
): Promise<EvidenceSource[]> {
  if (
    plate.state !== 'AK' ||
    ![plate.sourceUrl, plate.wikiUrl].some((link) =>
      ['doa.alaska.gov', 'dmv.alaska.gov'].includes(
        URL.parse(link ?? '')?.hostname ?? ''
      )
    )
  )
    return []

  const expected = normalize(plate.displayName)
  if (!expected) return []
  const page = { reserve: async () => true, now: Date.now }
  let detailUrl: string | undefined
  const listing = await fetchPage(directory, {
    ...page,
    extractHtml(html, url) {
      if (
        url.origin !== 'https://dmv.alaska.gov' ||
        url.pathname.replace(/\/$/, '') !== '/vehicle-services/license-plates'
      )
        return ''
      const root = parse(html)
      const cards = root.querySelectorAll('img').flatMap((image) => {
        const card = image.parentNode
        if (card?.tagName !== 'DIV') return []
        const imageIndex = card.children.indexOf(image)
        const cardName = clean(
          card.children
            .slice(0, imageIndex)
            .map((child) => clean(child.text))
            .join(' ')
        )
        if (normalize(cardName) !== expected) return []
        return [{ card, cardName, imageIndex }]
      })
      if (cards.length !== 1) return ''
      const { card, cardName, imageIndex } = cards[0]
      const details = card
        .querySelectorAll('a')
        .find((link) => clean(link.text).toLowerCase() === 'details')
      const href = URL.parse(details?.getAttribute('href') ?? '', url)
      if (
        details &&
        href?.origin === url.origin &&
        href.pathname.startsWith('/vehicle-services/') &&
        href.pathname !== url.pathname
      )
        detailUrl = href.href
      const section = clean(
        (card.parentNode?.previousElementSibling ?? card.previousElementSibling)
          ?.text ?? ''
      )
      const category =
        section.length < 100 && /license plates$/i.test(section)
          ? section.toLowerCase().replace(/plates$/, 'plate')
          : null
      const heading = category
        ? `Alaska DMV lists ${cardName} as a ${category} option.`
        : `Alaska DMV license plate listing for ${cardName}.`
      const lines = card.children
        .slice(imageIndex + 1)
        .map((child) => clean(child.structuredText))
        .filter(Boolean)
      return [heading, ...lines].join('\n')
    },
  })
  if (!listing) return []
  const detail = detailUrl && (await fetchPage(detailUrl, page))
  return detail && new URL(detail.url).origin === 'https://dmv.alaska.gov'
    ? [detail, listing]
    : [listing]
}

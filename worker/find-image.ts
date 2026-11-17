import { JURISDICTIONS } from '../lib/catalog/jurisdictions'
import { commonsImageUrl, commonsSourceUrl } from '../lib/jobs/image-options'
import type { ImageCandidate, ImageSuggestion } from '../lib/jobs/specialized-suggestions'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { boundedResponse, readCommonsImage } from './remote-image'

type ImagePlate = { state: string; displayName: string; image: string; imageUrl?: string | null }
type CommonsPage = { title?: string; index?: number; imageinfo?: { url?: string; thumburl?: string; descriptionurl?: string; mime?: string; extmetadata?: { LicenseShortName?: { value?: string }; Artist?: { value?: string } } }[] }

function candidateImageUrl(value?: string) {
  if (!value) return null
  try {
    const url = new URL(value)
    if ([...url.searchParams.keys()].some(key => !['utm_source', 'utm_campaign', 'utm_content'].includes(key))) return null
    url.search = ''
    return commonsImageUrl(url.href)
  } catch { return null }
}

export async function findImage(plate: ImagePlate, options: { fetch?: typeof fetch; onlyMissingImage?: boolean } = {}): Promise<ImageSuggestion | null> {
  if (options.onlyMissingImage && (plate.image || plate.imageUrl)) return null
  const request = options.fetch ?? fetch
  const query = `${JURISDICTIONS[plate.state] ?? plate.state} ${plate.displayName} license plate`
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.search = new URLSearchParams({ action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '5', gsrsearch: query, prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '640', format: 'json' }).toString()
  const response = await request(url.href, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'LocalMediaReview/1.0' } })
  const data = JSON.parse((await boundedResponse(response, 256 * 1024)).toString('utf8')) as { query?: { pages?: Record<string, CommonsPage> } }
  if ('error' in data) throw new Error('Commons search returned an error')
  const keywords = plate.displayName.toLowerCase().match(/[a-z0-9]+/g)?.filter(word => !['license', 'plate', 'plates', 'standard', 'passenger'].includes(word)) ?? []
  const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).slice(0, 5).filter(page => {
    const title = page.title?.toLowerCase() ?? ''
    return /plate/.test(title) && (!keywords.length || keywords.some(word => title.includes(word)))
  })
  const candidates: ImageCandidate[] = []
  for (const page of pages) {
    const info = page.imageinfo?.[0]
    const imageUrl = candidateImageUrl(info?.thumburl ?? info?.url)
    const sourceUrl = commonsSourceUrl(info?.descriptionurl)
    if (!imageUrl || !sourceUrl || !['image/png', 'image/jpeg', 'image/webp'].includes(info?.mime ?? '')) continue
    const bytes = await readCommonsImage(imageUrl, request)
    const metadata = await sharp(bytes).metadata()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const clean = (value?: string) => value?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500)
    const license = clean(info?.extmetadata?.LicenseShortName?.value)
    const author = clean(info?.extmetadata?.Artist?.value)
    if (!candidates.some(candidate => candidate.imageUrl === imageUrl || candidate.sha256 === sha256)) candidates.push({ id: sha256.slice(0, 20), imageUrl, sourceUrl, title: page.title!.slice(0, 300), width: metadata.width!, height: metadata.height!, sha256, ...(license ? { license } : {}), ...(author ? { author } : {}) })
  }
  return candidates.length ? { kind: 'image', stage: 'find-image', candidates, sources: [...new Set(candidates.flatMap(candidate => [candidate.imageUrl, candidate.sourceUrl]))].sort() } : null
}

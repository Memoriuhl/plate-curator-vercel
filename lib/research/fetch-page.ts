import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent, fetch as publicFetch } from 'undici'
import { parse } from 'node-html-parser'
import { evidenceSource } from './evidence'
import type { EvidenceSource } from './types'
import {
  isWikimediaHost,
  researchUserAgent,
  withRateLimitRetry,
} from './wikimedia'

export type PageDeps = {
  resolve?: (host: string) => Promise<string[]>
  fetch?: typeof fetch
  extractHtml?: (html: string, url: URL) => string
  reserve(): Promise<boolean>
  now(): number
}
const blocked = new BlockList()
for (const [parts, prefix] of [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 3],
] as [number[], number][])
  blocked.addSubnet(parts.join('.'), prefix, 'ipv4')
for (const [address, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
] as [string, number][])
  blocked.addSubnet(address, prefix, 'ipv6')

/** Check that a resolved address is public before allowing an evidence download. */
function allowedIp(ip: string) {
  const family = isIP(ip)
  if (family === 4) return !blocked.check(ip, 'ipv4')
  if (family !== 6) return false
  const first = Number.parseInt(ip.split(':')[0], 16)
  return first >= 0x2000 && first < 0x4000 && !blocked.check(ip, 'ipv6')
}

/** Extract bounded, readable page text for the evidence passed to the research model. */
export function readableText(html: string) {
  const root = parse(html)
  root
    .querySelectorAll(
      'script,style,noscript,template,svg,nav,header,footer,aside,form,iframe,button'
    )
    .forEach((node) => node.remove())
  const scope =
    root.querySelector('article') ??
    root.querySelector('main') ??
    root.querySelector('body') ??
    root
  const parts = scope
    .querySelectorAll('p,li,h2,h3,td,blockquote')
    .map((node) => node.text.replace(/\s+/g, ' ').trim())
    .filter((text) => text.length >= 40)
  return [...new Set(parts)].join('\n').slice(0, 6000)
}

/**
 * Fetch a bounded public evidence page while validating destinations and each redirect.
 */
export async function fetchResearchPage(
  url: string,
  deps: PageDeps
): Promise<EvidenceSource | null> {
  const resolve =
    deps.resolve ??
    (async (host) =>
      (await lookup(host, { all: true })).map((entry) => entry.address))
  /**
   * Resolve the host and reject it if any returned address falls outside the public
   * network policy.
   */
  const vetted = async (host: string) => {
    const addresses = isIP(host) ? [host] : await resolve(host)
    if (!addresses.length || !addresses.every(allowedIp))
      throw new Error('Source is not public')
    return addresses
  }
  /**
   * Use vetted addresses for the request's DNS lookup so the connection uses checked
   * destinations.
   */
  const dnsLookup: LookupFunction = (host, options, callback) => {
    void vetted(host).then(
      (addresses) => {
        const entries = addresses.map((address) => ({
          address,
          family: isIP(address),
        }))
        if (options.all)
          (
            callback as unknown as (
              error: null,
              records: typeof entries
            ) => void
          )(null, entries)
        else callback(null, entries[0].address, entries[0].family)
      },
      () => callback(new Error('Source is not public'), '', 0)
    )
  }
  const dispatcher = deps.fetch
    ? null
    : new Agent({ connect: { lookup: dnsLookup } })
  const request =
    deps.fetch ??
    (((target, init) =>
      publicFetch(target as string, {
        method: 'GET',
        headers: init?.headers as Record<string, string>,
        redirect: 'manual',
        signal: init?.signal,
        dispatcher: dispatcher!,
      }) as unknown as Promise<Response>) as typeof fetch)
  try {
    let current = new URL(url)
    for (let hop = 0; hop <= 5; hop++) {
      if (
        !['http:', 'https:'].includes(current.protocol) ||
        current.username ||
        current.password ||
        (current.port && !['80', '443'].includes(current.port))
      )
        return null
      await vetted(current.hostname.replace(/^\[|\]$/g, ''))
      if (!(await deps.reserve()))
        throw new Error('Research page limit exhausted')
      const target = current
      const send = () =>
        request(target.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': researchUserAgent },
        })
      // Wikipedia rate limits are retried; other hosts keep the single request.
      const response = isWikimediaHost(target.hostname)
        ? await withRateLimitRetry(send, { now: deps.now })
        : await send()
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel()
        current = new URL(location, current)
        continue
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (
        !response.ok ||
        !/^(text\/(html|plain)|application\/xhtml\+xml)(;|$)/i.test(
          contentType
        ) ||
        Number(response.headers.get('content-length')) > 1500000 ||
        !response.body
      ) {
        await response.body?.cancel()
        return null
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > 1500000) return null
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      const body = new TextDecoder().decode(Buffer.concat(chunks))
      const plain = /^text\/plain/i.test(contentType)
      if (plain && deps.extractHtml) return null
      const text = (
        plain
          ? body.replace(/\s+/g, ' ').trim()
          : (deps.extractHtml ?? readableText)(body, current)
      ).slice(0, 6000)
      if (text.length < (deps.extractHtml ? 40 : 200)) return null
      const title = /^text\/plain/i.test(contentType)
        ? current.hostname
        : parse(body).querySelector('title')?.text.trim() || current.hostname
      return evidenceSource(
        { kind: 'web', url: current.href, title: title.slice(0, 300), text },
        deps.now()
      )
    }
    return null
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Research page limit exhausted'
    )
      throw error
    return null
  } finally {
    await dispatcher?.close()
  }
}

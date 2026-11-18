import { createHash } from 'node:crypto'
import type { EvidenceSource } from './types'
import type { ResearchStateStore } from './state'

/** Build a stable evidence record from the normalized source URL and capture time. */
export function evidenceSource(
  input: {
    kind: EvidenceSource['kind']
    url: string
    title: string
    text: string
  },
  now = Date.now()
): EvidenceSource {
  const url = new URL(input.url)
  url.hash = ''
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid source URL')
  const contentHash = createHash('sha256').update(input.text).digest('hex')
  return {
    ...input,
    url: url.href,
    id:
      'S' +
      createHash('sha256')
        .update(url.href + contentHash)
        .digest('hex')
        .slice(0, 16),
    contentHash,
    fetchedAt: new Date(now).toISOString(),
  }
}

/** Keep the first capture per URL so the run's citations retain their IDs and text. */
export function saveEvidence(
  store: ResearchStateStore,
  runId: string,
  source: EvidenceSource
) {
  return store.update<EvidenceSource[], EvidenceSource>(
    `evidence/${runId}`,
    (prior) => {
      const value = prior ?? []
      const existing = value.find((entry) => entry.url === source.url)
      return existing
        ? { value, result: existing }
        : { value: [...value, source], result: source }
    }
  )
}

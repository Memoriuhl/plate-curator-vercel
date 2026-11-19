/**
 * Firestore accepts at most 10 MiB in one request. Freezing a release and folding the
 * migration each write the whole draft in one transaction, so both refuse past this
 * budget, which leaves room for document names and the per-field overhead the JSON
 * size does not count. Staging those writes in bounded chunks would lift it.
 */
export const draftWriteBudget = 9 * 1024 * 1024

export const DRAFT_TOO_LARGE_MESSAGE =
  'This draft is too large to publish in one write. Discard some changes so the rest can publish, then make them again in a later revision.'

const encoder = new TextEncoder()

/** Approximate request size of writing these documents, as UTF-8 JSON. */
export function writeBytes(docs: readonly unknown[]): number {
  return docs.reduce<number>(
    (total, doc) => total + encoder.encode(JSON.stringify(doc)).length,
    0
  )
}

/** Size in MiB with one decimal, for messages. */
export const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

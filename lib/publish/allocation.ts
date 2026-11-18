import type { PublishRecord } from './types'

/** Determine whether a receipt still reserves its target version for allocation. */
export const occupiesTarget = (
  record: Pick<PublishRecord, 'state' | 'committedAt'>
) => record.state !== 'abandoned' || !!record.committedAt

/**
 * Allocate the first safe version after the live pointer that is available to this
 * publish.
 */
export function nextPublishVersion(
  live: number,
  burns: Iterable<number>,
  receipts: Iterable<PublishRecord>
): number {
  if (!Number.isSafeInteger(live) || live < 0)
    throw new Error('Invalid Catalog version')
  const excluded = new Set(burns)
  for (const receipt of receipts)
    if (occupiesTarget(receipt)) excluded.add(receipt.toVersion)
  let version = live + 1
  while (Number.isSafeInteger(version) && excluded.has(version)) version++
  if (!Number.isSafeInteger(version))
    throw new Error('Catalog versions exhausted')
  return version
}

/**
 * Check that both snapshot versions are safe integers and that the target advances the
 * catalog.
 */
export const validTarget = (from: number, to: number) =>
  Number.isSafeInteger(from) &&
  from >= 0 &&
  Number.isSafeInteger(to) &&
  to > from

import type { PublishRecord } from './types'

export const occupiesTarget = (record: Pick<PublishRecord, 'state' | 'committedAt'>) => record.state !== 'abandoned' || !!record.committedAt

export function nextPublishVersion(live: number, burns: Iterable<number>, receipts: Iterable<PublishRecord>): number {
  if (!Number.isSafeInteger(live) || live < 0) throw new Error('Invalid Catalog version')
  const excluded = new Set(burns)
  for (const receipt of receipts) if (occupiesTarget(receipt)) excluded.add(receipt.toVersion)
  let version = live + 1
  while (Number.isSafeInteger(version) && excluded.has(version)) version++
  if (!Number.isSafeInteger(version)) throw new Error('Catalog versions exhausted')
  return version
}

export const validTarget = (from: number, to: number) => Number.isSafeInteger(from) && from >= 0 && Number.isSafeInteger(to) && to > from

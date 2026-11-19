import { randomUUID } from 'node:crypto'
import { receiptId } from './command'
import { PUBLISH_ERRORS } from './stop'
import type {
  PublishControl,
  PublishRecords,
  RequesterAuthority,
} from './types'
import { isRelease } from '../review/draft-id'
import type { ReleaseActivity, ReviewBatch } from '../review/types'

/**
 * What a release of the shared draft is doing. It is publishing while its run is live,
 * or after its receipt moved the pointer until that publish finishes. It is interrupted
 * when its run stopped after preparing a Snapshot and the Owner has not retried or
 * abandoned it. An abandoned release, or one whose run ended before preparing a
 * Snapshot, is idle (null).
 *
 * The run is checked with the authority of the Owner who asked for the release, so the
 * answer is the same whoever looks: a viewer without Owner authority would otherwise be
 * refused before the run is inspected and see a live release as idle. The viewer's
 * authority is used only for a release whose request did not record one.
 */
export async function classifyRelease(
  records: PublishRecords,
  release: ReviewBatch,
  generation: number | undefined,
  now: string,
  viewer?: RequesterAuthority
): Promise<ReleaseActivity> {
  if (release.publishAbandonment) return null
  const receipt = await records.get(receiptId(release.id, release.revision))
  if (receipt?.committedAt)
    return receipt.state === 'done' ? null : 'publishing'
  const pending = release.publishCommand?.commandId
  const requestedBy =
    release.publishRequestedBy ??
    (pending ? (await records.command(pending))?.command.requestedBy : null) ??
    viewer
  const { reason } = await records.eligibility(
    {
      batchId: release.id,
      revision: release.revision,
      commandId: randomUUID(),
      requestedBy,
      generation,
    },
    now
  )
  if (reason === 'locked' || reason === PUBLISH_ERRORS.notWaiting)
    return 'publishing'
  return receipt?.state === 'uploaded' ? 'interrupted' : null
}

/**
 * The approved releases of a draft, newest first, with what each is doing. Publish of a
 * newer revision waits while any of them is publishing or interrupted.
 */
export async function draftReleases(
  approved: readonly ReviewBatch[],
  draftId: string,
  classify: (release: ReviewBatch) => Promise<ReleaseActivity>
) {
  return Promise.all(
    approved
      .filter((batch) => isRelease(batch) && batch.source?.batchId === draftId)
      .sort(
        (left, right) =>
          (right.source?.revision ?? 0) - (left.source?.revision ?? 0)
      )
      .map(async (release) => ({ release, activity: await classify(release) }))
  )
}

/**
 * The classification for review operations, which act for curators rather than an
 * Owner: each release is checked with the authority recorded on its own request.
 */
export function releaseActivityFor(
  records: PublishRecords,
  control: Pick<PublishControl, 'read'>,
  now: () => string
) {
  return async (release: ReviewBatch) =>
    classifyRelease(records, release, (await control.read())?.generation, now())
}

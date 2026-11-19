import { json } from './respond'

/**
 * Answer a request for a Batch step the shared draft replaced. Every curator now writes
 * into one draft, and the Owner publishes it directly.
 */
export function batchStepRetired() {
  return json(
    {
      error: 'batches_retired',
      message:
        'Batches were replaced by one shared draft. Edit the draft; the Owner publishes it.',
    },
    410
  )
}

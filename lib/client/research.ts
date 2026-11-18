import { ApiError } from './api'

/**
 * Translate a research API error into a message that tells the curator how to recover.
 */
export function researchMessage(error: unknown) {
  if (!(error instanceof ApiError))
    return 'Could not reach research. Check your connection, then retry.'
  const messages: Record<string, string> = {
    forbidden:
      'Research starts require an active Owner; Batch access is required to review.',
    unavailable:
      'This research host is not configured. Choose another host for a new run.',
    stale_input:
      'This plate changed since research started. Start a replacement run before accepting.',
    stale_plate: 'This plate changed. Refresh before accepting.',
    superseded: 'This run was replaced. Review the newer run.',
    invalid_result:
      'The selected draft failed its citation or length checks. Check the text and captured sources.',
    invalid_state: 'This Batch or run is no longer editable.',
    not_found: 'This research run or Batch is unavailable.',
  }
  return (
    messages[error.code] ??
    'Research could not complete. Refresh to inspect its saved status.'
  )
}

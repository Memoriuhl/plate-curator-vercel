import { BOOT_WAIT_CAP_MS } from './splash-timeline'

const PENDING = '.session-loading, .dashboard-skeleton'

/** Whether the page still shows the access check or a dashboard skeleton. */
export function launchContentPending(root: ParentNode): boolean {
  return root.querySelector(PENDING) !== null
}

/**
 * Whether the launch splash can pop: signed in, past the home redirect and nothing
 * left loading, or the boot has run past the cap.
 */
export function launchReady({
  sessionReady,
  pathname,
  pending,
  elapsedMs,
}: {
  sessionReady: boolean
  pathname: string
  pending: boolean
  elapsedMs: number
}): boolean {
  if (elapsedMs >= BOOT_WAIT_CAP_MS) return true
  return sessionReady && pathname !== '/' && !pending
}

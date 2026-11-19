'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from '../../lib/client/session'
import {
  launchContentPending,
  launchReady,
} from '../../lib/launch/launch-ready'
import { LaunchSplash } from './launch-splash'

const CHECK_MS = 100
const STABLE_CHECKS = 3

/**
 * Play the launch splash once per page load and pop it when the dashboard has
 * settled: signed in, redirected to a state, and no access check or skeleton left.
 */
export function LaunchSplashHost() {
  const { ready: sessionReady } = useSession()
  const pathname = usePathname()
  const [ready, setReady] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (ready) return
    let stable = 0
    const id = setInterval(() => {
      const settled = launchReady({
        sessionReady,
        pathname,
        pending: launchContentPending(document),
        elapsedMs: performance.now(),
      })
      stable = settled ? stable + 1 : 0
      if (stable >= STABLE_CHECKS) setReady(true)
    }, CHECK_MS)
    return () => clearInterval(id)
  }, [ready, sessionReady, pathname])

  if (done) return null
  return <LaunchSplash ready={ready} onDone={() => setDone(true)} />
}

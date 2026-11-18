import type { NextConfig } from 'next'
import { withWorkflow } from 'workflow/next'
import { withEve } from 'eve/next'

const nextConfig: NextConfig = {
  agentRules: false,
  // Enable explicit server cache boundaries and prefetch page shells for faster navigation.
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Reuse dynamic page segments in the browser router cache during quick state switches.
    staleTimes: { dynamic: 300 },
  },
}

export default withEve(withWorkflow(nextConfig))

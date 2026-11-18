import type { NextConfig } from 'next'
import { withWorkflow } from 'workflow/next'
import { withEve } from 'eve/next'

const nextConfig: NextConfig = {
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    staleTimes: { dynamic: 300 },
  },
}

export default withEve(withWorkflow(nextConfig))

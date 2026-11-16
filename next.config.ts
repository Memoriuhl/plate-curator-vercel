import type { NextConfig } from 'next'
import { withWorkflow } from 'workflow/next'

const nextConfig: NextConfig = {
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    staleTimes: { dynamic: 300 },
  },
}

export default withWorkflow(nextConfig)

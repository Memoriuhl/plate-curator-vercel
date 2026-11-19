import {
  searchProviderEnvironment,
  searchProviderHealth,
} from '../lib/research/provider-health'

/**
 * Print which web search providers this environment can use. `--probe` spends one
 * search per configured provider; key values are never printed.
 */
async function main() {
  const probe = process.argv.includes('--probe')
  const health = await searchProviderHealth({
    ...searchProviderEnvironment(),
    probe,
  })
  console.log(JSON.stringify(health, null, 2))
  if (
    probe &&
    health.mode === 'serper-brave' &&
    !health.providers.some((provider) => provider.status === 'available')
  )
    process.exitCode = 1
}

void main()

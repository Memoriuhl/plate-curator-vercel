import { expect, test } from 'vitest'
import { gatewayParallelSearch } from '../../lib/research/gateway-search'

test('search budget refusal sends neither a Gateway model call nor a search', async () => {
  let calls = 0
  const result = await gatewayParallelSearch('Arizona Highways plate', { /** Refuse the tool reservation so the test can exercise an exhausted budget. */ reserve: async () => false, /** Detect an unexpected model call when the search budget cannot be reserved. */ generate: async () => { calls++; throw new Error('unexpected') } })
  expect(result).toMatchObject({ status: 'exhausted', hits: [] })
  expect(calls).toBe(0)
})

test('Gateway search returns leads without treating excerpts as fetched evidence', async () => {
  const result = await gatewayParallelSearch('Arizona Highways plate', { /** Allow the fixture evidence request without consuming a real tool budget. */ reserve: async () => true, /** Return controlled search hits and reported Gateway spend for normalization assertions. */ generate: async () => ({ toolResults: [{ output: { results: [{ title: 'Official', url: 'https://example.com/plate', excerpts: ['A search excerpt'] }, { title: 'Unsafe', url: 'javascript:alert(1)', excerpts: [] }] } }], providerMetadata: { gateway: { cost: '0.007' } } }) })
  expect(result).toMatchObject({ status: 'ok', provider: 'gateway-parallel', hits: [{ title: 'Official', url: 'https://example.com/plate', snippet: 'A search excerpt' }], usd: 0.007 })
  expect(result.hits).toHaveLength(1)
})

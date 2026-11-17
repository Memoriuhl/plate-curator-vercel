import { expect, test } from 'vitest'
import { createMemoryResearchStore } from '../../lib/research/memory-store'
import { issueResearchWorkerToken, researchWorkerIdentity, revokeResearchWorkerToken, researchServiceToken, verifyResearchServiceToken } from '../../lib/research/tokens'
import type { ResearchJob } from '../../lib/research/types'

test('research worker credentials are revoked and bound to their environment', async () => {
  const store = createMemoryResearchStore()
  const credential = await issueResearchWorkerToken(store, 'desktop')
  const request = new Request('https://example.com/api/research-worker/claim', { headers: { Authorization: `Bearer ${credential.token}` } })
  expect(await researchWorkerIdentity(store, request)).toBe('desktop')
  expect(await researchWorkerIdentity(store.forEnvironment('production'), request)).toBeNull()
  await revokeResearchWorkerToken(store, credential.hash)
  expect(await researchWorkerIdentity(store, request)).toBeNull()
})

test('service capabilities bind the originating job, requester and environment', async () => {
  const secret = 'fixture-secret-for-scoped-service-capabilities'
  const token = await researchServiceToken({ id: 'job', requestedBy: 'owner', env: 'development' } as ResearchJob, secret)
  expect(await verifyResearchServiceToken(token, secret, 'development')).toEqual({ uid: 'owner', jobId: 'job' })
  expect(await verifyResearchServiceToken(token, secret, 'production')).toBeNull()
  expect(await verifyResearchServiceToken(token, 'another-fixture-secret-of-sufficient-length', 'development')).toBeNull()
})

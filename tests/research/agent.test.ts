import { expect, test } from 'vitest'
import { createResearchMemoryState } from '../../lib/research/state'
import { submitResearchDraft } from '../../lib/research/runtime'

test('draft submission durably stores a screened result rather than trusting generated citations', async () => {
  const store = createResearchMemoryState()
  await store.update('session/session', () => ({
    value: { ownerUid: 'owner', jobId: 'job' },
    result: null,
  }))
  const output = await submitResearchDraft(
    { session: { id: 'session', turn: { id: 'turn' } } },
    {
      description:
        'This invented claim has enough words to look like a real plate description.',
      descriptionSources: ['fabricated'],
      funFacts: [],
      readMore: ['fabricated'],
      wikiSource: null,
    },
    store
  )
  expect(output).toMatchObject({
    status: 'no_sources',
    draft: { description: null, funFacts: [], readMore: [] },
  })
  expect(await store.read('draft/job')).toMatchObject({
    draft: { description: null },
    rejected: expect.arrayContaining([
      { field: 'description', reason: 'source_not_fetched' },
    ]),
  })
})

import { afterEach, expect, test, vi } from 'vitest'
import { proposeEdit, reorderState } from '../../lib/review/batches/batch'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/draft/revision'
import type { Plate } from '../../lib/catalog/types'
import type { ReviewDeps } from '../../lib/review/types'

afterEach(() => vi.unstubAllEnvs())

test.each(['choose', 'reorder'] as const)(
  'story edits survive a Standard change through %s with editing disabled',
  async (action) => {
    vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
    const plates: Plate[] = ['one', 'two'].map((id, index) => ({
      id,
      state: 'CA',
      slug: id,
      displayName: id,
      image: '',
      tags: [],
      templateRole: 'template',
      templateFamily: id,
      isStandard: index === 0,
    }))
    const actor = { uid: 'story-editor', name: null, role: 'editor' as const }
    const store = createMemoryStore([
      {
        id: 'story-standard',
        name: 'Story Standard',
        baselineVersion: 1,
        plateIds: [],
        revision: 0,
        approval: null,
        state: 'open',
        createdAt: '',
        createdBy: actor.uid,
      },
    ])
    const deps: ReviewDeps = {
      store,
      /** Resolve the plate by ID from the fixture baseline. */ baseline:
        async (id) => plates.find((plate) => plate.id === id) ?? null,
      /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
        async (_version, id) => plates.find((plate) => plate.id === id) ?? null,
      /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
        async () => plates,
      /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
        '',
    }
    const story = {
      funFacts: [
        { text: 'Sourced fact', sourceUrl: 'http://example.org/fact' },
      ],
      firstIssuedYear: 1976,
      readMore: [
        {
          title: 'Reference',
          site: 'Example',
          url: 'https://example.org/reference',
        },
      ],
    }
    for (const plate of plates) {
      expect(
        await proposeEdit(deps, actor, {
          batchId: 'story-standard',
          plateId: plate.id,
          baseRevision: plateRevision(plate),
          fields: story,
        })
      ).toMatchObject({ ok: true })
    }
    vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
    const standard = { from: 'one', to: 'two' }
    const outcome =
      action === 'choose'
        ? await proposeEdit(deps, actor, {
            batchId: 'story-standard',
            plateId: 'two',
            baseRevision: plateRevision({ ...plates[1], ...story }),
            fields: { isStandard: true },
            standard,
          })
        : await reorderState(deps, actor, {
            batchId: 'story-standard',
            state: 'CA',
            batchRevision: 2,
            order: ['two', 'one'],
            standard,
          })
    expect(outcome).toMatchObject({ ok: true })
    expect((await store.getEdit('story-standard', 'one'))?.fields).toEqual({
      ...story,
      isStandard: false,
    })
    expect((await store.getEdit('story-standard', 'two'))?.fields).toEqual({
      ...story,
      isStandard: true,
    })
    expect((await store.getBatch('story-standard'))?.stateOrders.CA).toEqual([
      'two',
      'one',
    ])
  }
)

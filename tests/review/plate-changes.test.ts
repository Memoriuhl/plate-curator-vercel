import { expect, test } from 'vitest'
import {
  changeDetail,
  familyTemplateId,
  matchesPublishFilter,
  plateChanges,
  publishChanges,
  tagDelta,
} from '../../lib/review/plate-changes'
import type { BatchDetail } from '../../lib/client/hooks'
import type { Plate } from '../../lib/catalog/types'

type Entry = BatchDetail['plates'][number]

/** Build a catalog plate with the fields these checks read. */
function plate(id: string, fields: Partial<Plate> = {}): Plate {
  return {
    id,
    state: id.split('.')[0],
    slug: id.split('.')[1],
    displayName: id.split('.')[1],
    tags: [],
    image: `${id}.webp`,
    ...fields,
  }
}

/** Build a draft entry whose proposal applies the given fields to the baseline. */
function entry(
  id: string,
  proposed: Partial<Plate> = {},
  extra: Partial<Entry> = {},
  baseline: Partial<Plate> = {}
): Entry {
  const before = plate(id, baseline)
  return {
    baseline: before,
    proposed: { ...before, ...proposed },
    edit: null,
    revision: 'r1',
    ...extra,
  }
}

const author = (name: string) =>
  ({
    plateId: 'x',
    baseRevision: 'r0',
    fields: {},
    authorId: `${name}-uid`,
    authorName: name,
    updatedAt: '2026-11-18T10:00:00Z',
    resultRevision: 'r1',
  }) as unknown as Entry['edit']

test('a plate lists each kind of change once, in the Review icon order', () => {
  expect(
    plateChanges(
      entry(
        'AK.air_force',
        {
          tags: ['eagle'],
          description: 'New',
          templateFamily: 'ak_artistic_license',
          variantOfPlateId: 'AK.celebrating_the_arts',
          templateRole: 'variant',
        },
        { order: { before: 4, after: 1, total: 44 } }
      )
    ).map((change) => change.key)
  ).toEqual(['description', 'tags', 'family', 'order'])
})

test('an entry with nothing different is not a change', () => {
  expect(plateChanges(entry('AK.caribou'))).toEqual([])
})

test('deletion and restoration are their own changes', () => {
  expect(
    plateChanges(entry('AK.one', { deleted: true })).map((c) => c.key)
  ).toEqual(['deleted'])
  expect(
    plateChanges(
      entry('AK.one', { deleted: false }, {}, { deleted: true })
    ).map((c) => c.key)
  ).toEqual(['restored'])
})

test('a tag change reports what was added and removed and the counts', () => {
  expect(tagDelta(['farm', 'barn'], ['barn', 'flag', 'cow'])).toEqual({
    added: ['flag', 'cow'],
    removed: ['farm'],
    from: 2,
    to: 3,
  })
})

test("a plate's family template is the plate it varies, or itself when it is the template", () => {
  expect(
    familyTemplateId(
      plate('AK.air_force', {
        templateFamily: 'ak_veteran',
        variantOfPlateId: 'AK.army',
      })
    )
  ).toBe('AK.army')
  expect(
    familyTemplateId(
      plate('AK.army', {
        templateFamily: 'ak_veteran',
        templateRole: 'template',
      })
    )
  ).toBe('AK.army')
  expect(familyTemplateId(plate('AK.lone'))).toBeNull()
})

test('Publish groups changed plates by state, skips untouched entries and counts each kind', () => {
  const result = publishChanges([
    entry('AL.audubon', { tags: ['bird'] }, { edit: author('pcv-editor') }),
    entry('AK.caribou'),
    entry('AK.lions_club', {}, { order: { before: 12, after: 3, total: 44 } }),
    entry(
      'AK.pws',
      { tags: ['seal'] },
      { edit: author('pcv-editor'), order: { before: 2, after: 5, total: 44 } }
    ),
    entry('AK.army', { deleted: true }, { edit: author('pcv-owner') }),
  ])
  expect(
    result.states.map((state) => [
      state.code,
      state.plates.map((p) => p.entry.baseline.id),
    ])
  ).toEqual([
    ['AK', ['AK.lions_club', 'AK.pws', 'AK.army']],
    ['AL', ['AL.audubon']],
  ])
  expect(result.counts).toEqual({ all: 4, edited: 2, moved: 2, removed: 1 })
  expect(result.states[0]).toMatchObject({ edited: 1, moved: 2, removed: 1 })
  expect(result.authors).toEqual([
    { uid: 'pcv-editor-uid', name: 'pcv-editor', plates: 2 },
    { uid: 'pcv-owner-uid', name: 'pcv-owner', plates: 1 },
  ])
})

test('the Publish filter matches a kind of change and searches names, ids, states and changes', () => {
  const [state] = publishChanges([
    entry('AK.pws', { tags: ['seal'], displayName: 'PWS' }),
  ]).states
  const [pws] = state.plates
  expect(matchesPublishFilter(pws, 'edited', '')).toBe(true)
  expect(matchesPublishFilter(pws, 'moved', '')).toBe(false)
  expect(matchesPublishFilter(pws, 'all', 'pws')).toBe(true)
  expect(matchesPublishFilter(pws, 'all', 'AK.p')).toBe(true)
  expect(matchesPublishFilter(pws, 'all', 'alaska')).toBe(true)
  expect(matchesPublishFilter(pws, 'all', 'tags')).toBe(true)
  expect(matchesPublishFilter(pws, 'all', 'order')).toBe(false)
})

test('each change icon describes what changed, before and after', () => {
  const research = entry(
    'AK.army',
    {
      description: 'Honors soldiers.',
      funFacts: [
        { text: 'First issued in 1990.', sourceUrl: 'https://a.test' },
      ],
      readMore: [
        { title: 'A', site: 'a.test', url: 'https://a.test' },
        { title: 'B', site: 'b.test', url: 'https://b.test' },
      ],
      wikiUrl: 'https://en.wikipedia.org/wiki/Army',
      tags: ['army', 'service'],
    },
    {},
    { tags: ['army', 'old'] }
  )
  expect(changeDetail(research, 'description')).toEqual([
    'Added: Honors soldiers.',
  ])
  expect(changeDetail(research, 'funFacts')).toEqual([
    '0 facts → 1 fact',
    'New: First issued in 1990.',
  ])
  expect(changeDetail(research, 'tags')).toEqual([
    'Added: service',
    'Removed: old',
  ])
  expect(changeDetail(research, 'link')).toEqual([
    'Reference page: Added: https://en.wikipedia.org/wiki/Army',
    'Read more: 0 links → 2 links',
  ])
  expect(
    changeDetail(
      entry('AK.army', { description: 'New' }, {}, { description: 'Old' }),
      'description'
    )
  ).toEqual(['Old → New'])
  expect(
    changeDetail(
      entry('AK.army', {}, { order: { before: 0, after: 2, total: 5 } }),
      'order'
    )
  ).toEqual(['Position 1 → 3 of 5'])
})

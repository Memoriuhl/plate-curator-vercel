import { afterEach, expect, test, vi } from 'vitest'
import { parseFieldSuggestion } from '../../lib/jobs/suggestions'
import {
  parseGroupSuggestion,
  parseImageSuggestion,
} from '../../lib/jobs/specialized-suggestions'

afterEach(() => vi.unstubAllEnvs())
export const imageResult = {
  kind: 'image',
  stage: 'find-image',
  candidates: [
    {
      id: 'candidate',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg',
      title: 'Plate',
      width: 640,
      height: 320,
      sha256: 'a'.repeat(64),
    },
  ],
  sources: [
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
    'https://commons.wikimedia.org/wiki/File:Plate.jpg',
  ],
} as const
const revision = 'a'.repeat(20)
export const groupResult = {
  kind: 'group',
  stage: 'group',
  sources: [],
  scope: [
    { plateId: 'AK.a', baseRevision: revision },
    { plateId: 'AK.b', baseRevision: revision },
  ],
  proposals: [
    {
      plateId: 'AK.a',
      baseRevision: revision,
      fields: {
        templateFamily: 'AK.a',
        templateRole: 'template',
        variantOfPlateId: null,
      },
    },
    {
      plateId: 'AK.b',
      baseRevision: revision,
      fields: {
        templateFamily: 'AK.a',
        templateRole: 'variant',
        variantOfPlateId: 'AK.a',
      },
    },
  ],
} as const

test('specialized image results require local gate, raster allowlist and both provenance links', () => {
  expect(parseFieldSuggestion(imageResult, 'find-image')).toBeNull()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseFieldSuggestion(imageResult, 'find-image')).toMatchObject({
    kind: 'image',
    candidates: imageResult.candidates,
  })
  expect(parseFieldSuggestion(imageResult, 'group')).toBeNull()
  for (const imageUrl of [
    'http://localhost/plate.jpg',
    'https://upload.wikimedia.org.evil.org/wikipedia/commons/a.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a.svg',
    'https://user@upload.wikimedia.org/wikipedia/commons/a.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a.jpg?redirect=local',
  ]) {
    expect(
      parseImageSuggestion({
        ...imageResult,
        candidates: [{ ...imageResult.candidates[0], imageUrl }],
      })
    ).toBeNull()
  }
  expect(
    parseImageSuggestion({
      ...imageResult,
      sources: [imageResult.candidates[0].imageUrl],
    })
  ).toBeNull()
  expect(parseImageSuggestion({ ...imageResult, candidates: [] })).toBeNull()
  expect(
    parseImageSuggestion({
      ...imageResult,
      candidates: [{ ...imageResult.candidates[0], sha256: ['a'.repeat(64)] }],
    })
  ).toBeNull()
  expect(
    parseFieldSuggestion(
      {
        kind: 'fields',
        stage: 'find-image',
        fields: { sourceUrl: imageResult.candidates[0].sourceUrl },
        sources: imageResult.sources,
      },
      'find-image'
    )
  ).toBeNull()
})

test('group results describe a complete bounded scope and one valid template per family', () => {
  expect(parseGroupSuggestion(groupResult)).toEqual(groupResult)
  expect(
    parseGroupSuggestion({
      ...groupResult,
      proposals: groupResult.proposals.slice(1),
    })
  ).toBeNull()
  expect(
    parseGroupSuggestion({
      ...groupResult,
      scope: [groupResult.scope[0], groupResult.scope[0]],
    })
  ).toBeNull()
  expect(
    parseGroupSuggestion({
      ...groupResult,
      proposals: [
        groupResult.proposals[0],
        { ...groupResult.proposals[1], baseRevision: 'b'.repeat(20) },
      ],
    })
  ).toBeNull()
  expect(
    parseGroupSuggestion({
      ...groupResult,
      proposals: [
        groupResult.proposals[0],
        {
          ...groupResult.proposals[1],
          fields: {
            ...groupResult.proposals[1].fields,
            variantOfPlateId: 'AK.outside',
          },
        },
      ],
    })
  ).toBeNull()
  expect(
    parseGroupSuggestion({
      ...groupResult,
      proposals: groupResult.proposals.map((value) => ({
        ...value,
        fields: { ...value.fields, isStandard: true },
      })),
    })
  ).toBeNull()
  expect(
    parseGroupSuggestion({ ...groupResult, order: ['AK.b', 'AK.a'] })
  ).toBeNull()
  expect(
    parseGroupSuggestion({
      ...groupResult,
      scope: [
        { ...groupResult.scope[0], baseRevision: 12345678901234567890 },
        groupResult.scope[1],
      ],
    })
  ).toBeNull()
})

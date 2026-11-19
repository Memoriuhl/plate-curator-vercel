import { afterEach, expect, test, vi } from 'vitest'
import sharp from 'sharp'
import { findImage } from '../../worker/find-image'
import { readCommonsImage } from '../../worker/remote-image'
import { createImageGroupRunner, groupProposal } from '../../worker/image-group'
import { plateRevision } from '../../lib/review/revision'
import type { GroupInput } from '../../lib/jobs/specialized-suggestions'
import { parseEditableFields } from '../../lib/review/fields'
import { validateSnapshot } from '../../lib/publish/validation'
import { imageReader } from '../../worker/images'

afterEach(() => vi.unstubAllEnvs())
const imageUrl =
  'https://upload.wikimedia.org/wikipedia/commons/a/ab/Alaska_plate.jpg'
const sourceUrl = 'https://commons.wikimedia.org/wiki/File:Alaska_plate.jpg'
const plate = {
  id: 'AK.a',
  state: 'AK',
  slug: 'a',
  displayName: 'Alaska Standard',
  image: '',
  tags: [],
  isStandard: true,
}
const scope: GroupInput = [
  plate,
  { ...plate, id: 'AK.b', slug: 'b', isStandard: false },
].map((plate) => ({ plate, baseRevision: plateRevision(plate) }))

test('Find image offers validated raster candidates with provenance instead of autoapplying', async () => {
  const bytes = await sharp({
    create: { width: 640, height: 320, channels: 3, background: '#eee' },
  })
    .jpeg()
    .toBuffer()
  const request = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return String(url).startsWith('https://commons.wikimedia.org/w/api.php')
        ? Response.json({
            query: {
              pages: {
                '1': {
                  title: 'File:Alaska license plate.jpg',
                  imageinfo: [
                    {
                      url: imageUrl,
                      descriptionurl: sourceUrl,
                      mime: 'image/jpeg',
                      extmetadata: {
                        Artist: { value: '<b>Author</b>' },
                        LicenseShortName: { value: 'CC BY 4.0' },
                      },
                    },
                  ],
                },
              },
            },
          })
        : new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })
    }
  )
  const result = await findImage(plate, { fetch: request })
  expect(result).toMatchObject({
    kind: 'image',
    candidates: [
      {
        imageUrl,
        sourceUrl,
        width: 640,
        height: 320,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        author: 'Author',
        license: 'CC BY 4.0',
      },
    ],
    sources: expect.arrayContaining([imageUrl, sourceUrl]),
  })
  expect(request.mock.calls[1][1]).toMatchObject({ redirect: 'error' })
  expect(plate.image).toBe('')
  expect(
    await findImage(
      { ...plate, image: 'existing.webp' },
      { fetch: request, onlyMissingImage: true }
    )
  ).toBeNull()
})

test('image requests enforce host/content/byte/dimension limits and retry network failures explicitly', async () => {
  const request = vi.fn(
    async () =>
      new Response('<svg></svg>', {
        headers: { 'content-type': 'image/svg+xml' },
      })
  )
  await expect(
    readCommonsImage('http://localhost/a.jpg', request)
  ).rejects.toThrow('Only Wikimedia')
  expect(request).not.toHaveBeenCalled()
  await expect(readCommonsImage(imageUrl, request)).rejects.toThrow(
    'content type'
  )
  await expect(
    readCommonsImage(
      imageUrl,
      async () =>
        new Response('bad', {
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(9 * 1024 * 1024),
          },
        })
    )
  ).rejects.toThrow('too large')
  const tiny = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#eee' },
  })
    .png()
    .toBuffer()
  await expect(
    readCommonsImage(
      imageUrl,
      async () =>
        new Response(tiny, { headers: { 'content-type': 'image/png' } })
    )
  ).rejects.toThrow('Unsupported image content')
  const retry = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ query: { pages: {} } }))
  await expect(findImage(plate, { fetch: retry })).rejects.toThrow('offline')
  expect(await findImage(plate, { fetch: retry })).toBeNull()
})

test('Group reports complete proposals, keeps Standard as anchor and only calls bounded tiebreak for near matches', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const tiebreak = vi.fn(async () => true)
  const embed = vi.fn(async () => ({
    model: 'dinov2_vits14',
    groups: [
      { templateId: 'AK.a', variants: [] },
      { templateId: 'AK.b', variants: [] },
    ],
    similarities: [
      [1, 0.82],
      [0.82, 1],
    ],
  }))
  const run = createImageGroupRunner({ embed, tiebreak })
  const result = await run({
    stage: 'group',
    plate,
    groupScope: scope,
    options: {
      method: 'embeddings',
      colorSignal: true,
      backgroundMask: true,
      visionTiebreak: true,
    },
  })
  expect(result.fieldSuggestion).toMatchObject({
    kind: 'group',
    proposals: [
      { plateId: 'AK.a', fields: { templateRole: 'template' } },
      {
        plateId: 'AK.b',
        fields: { templateRole: 'variant', variantOfPlateId: 'AK.a' },
      },
    ],
  })
  expect(embed).toHaveBeenCalledWith(scope, {
    method: 'embeddings',
    colorSignal: true,
    backgroundMask: true,
    visionTiebreak: true,
  })
  expect(tiebreak).toHaveBeenCalledTimes(1)
  expect(
    groupProposal(scope, {
      model: 'test',
      groups: [{ templateId: 'AK.outside', variants: [] }],
      similarities: [],
    })
  ).toBeNull()
  expect(
    await run({ stage: 'group', plate, groupScope: scope.slice(0, 1) })
  ).toMatchObject({ stageError: 'no_supported_fields' })
  expect(
    await run({
      stage: 'find-image',
      plate: { ...plate, image: 'existing.webp' },
      options: { onlyMissingImage: true },
    })
  ).toMatchObject({ stageError: 'no_sources' })
})

test('image override edits are paired, gated and cannot publish before managed upload', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseEditableFields({ sourceUrl })).toBeNull()
  expect(parseEditableFields({ imageUrl })).toBeNull()
  expect(parseEditableFields({ imageUrl, sourceUrl })).toBeNull()
  expect(
    parseEditableFields({ imageUrl, sourceUrl }, { imageUrl, sourceUrl })
  ).toEqual({ imageUrl, sourceUrl })
  expect(
    parseEditableFields(
      { imageUrl, sourceUrl: 'not a URL' },
      { imageUrl, sourceUrl: 'not a URL' }
    )
  ).toBeNull()
  expect(
    parseEditableFields({ imageUrl, sourceUrl: null }, { imageUrl, sourceUrl })
  ).toBeNull()
  expect(
    parseEditableFields(
      { imageUrl, sourceUrl: 'https://example.org' },
      { imageUrl, sourceUrl: 'https://example.org' }
    )
  ).toBeNull()
  expect(parseEditableFields({ imageUrl: null, sourceUrl: null })).toEqual({
    imageUrl: null,
    sourceUrl: null,
  })
  const longSource = `https://commons.wikimedia.org/wiki/File:${'Alaska_'.repeat(20)}Plate.jpg`
  expect(longSource.length).toBeGreaterThan(120)
  expect(
    parseEditableFields(
      { imageUrl, sourceUrl: longSource },
      { imageUrl, sourceUrl: longSource }
    )
  ).toEqual({ imageUrl, sourceUrl: longSource })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(parseEditableFields({ imageUrl, sourceUrl })).toBeNull()
  expect(
    validateSnapshot(
      { version: 1, plates: [plate] },
      { version: 2, plates: [{ ...plate, imageUrl, sourceUrl }] }
    )
  ).toContain('Image candidate needs upload before publishing')
  expect(
    validateSnapshot(
      { version: 1, plates: [{ ...plate, imageUrl, sourceUrl }] },
      {
        version: 2,
        plates: [{ ...plate, imageUrl, sourceUrl, tags: ['updated'] }],
      }
    )
  ).not.toContain('Image candidate needs upload before publishing')
})

test('flag-off imageReader preserves path-only behavior and never fetches remote URLs', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Must not fetch'))
  try {
    await expect(
      imageReader('C:/nonexistent-local-fixture')(imageUrl)
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  } finally {
    request.mockRestore()
  }
})

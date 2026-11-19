import { expect, test } from 'vitest'
import { proposeEdit } from '../../lib/review/batches/batch'
import { approveBatch, submitBatch } from '../helpers/legacy-approval'
import { plateRevision } from '../../lib/review/revision'
import { publishBatch } from '../../lib/publish/publish'
import { buildPlate } from '../../lib/catalog/dashboard-build'
import { fixture, owner, snapshot, command } from '../publish/fixture'

const fields = {
  description:
    'This specialty plate supports wildlife habitat conservation throughout the state.',
  funFacts: [
    {
      text: 'The wildlife program began in 1987.',
      sourceUrl: 'https://example.com/wildlife',
      sourceTitle: 'Wildlife',
    },
  ],
  readMore: [
    {
      title: 'Wildlife program',
      url: 'https://example.com/wildlife',
      site: 'example.com',
    },
  ],
  wikiUrl: 'https://en.wikipedia.org/wiki/Wildlife',
}

test('every research field changes the revision, clears approval and survives the real Snapshot serializer', async () => {
  for (const field of Object.keys(fields))
    expect(
      plateRevision({
        ...snapshot.plates[0],
        [field]: fields[field as keyof typeof fields],
      })
    ).not.toBe(plateRevision(snapshot.plates[0]))
  const f = fixture()
  const proposed = await proposeEdit(f.deps, owner, {
    batchId: 'batch',
    plateId: 'one',
    baseRevision: plateRevision(snapshot.plates[0]),
    fields,
  })
  expect(proposed).toMatchObject({
    ok: true,
    value: {
      batch: { revision: 3, state: 'open', approval: null },
      plate: fields,
    },
  })
  expect(await submitBatch(f.deps, owner, 'batch', 3)).toMatchObject({
    ok: true,
  })
  expect(await approveBatch(f.deps, owner, 'batch', 4)).toMatchObject({
    ok: true,
  })
  expect(
    await publishBatch(f.deps, owner, {
      ...command,
      revision: 5,
      commandId: 'research-roundtrip',
    })
  ).toMatchObject({ ok: true })
  const serialized = JSON.parse(Buffer.from(f.blobs.get(2)!).toString())
  expect(serialized.plates[0]).toMatchObject(fields)
  expect(
    buildPlate(
      serialized,
      { stateOrder: {}, stateProgress: {} },
      () => null,
      'one'
    )!.plate
  ).toMatchObject(fields)
})

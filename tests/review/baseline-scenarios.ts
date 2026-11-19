import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { claimJob, createJob, reportResult } from '../../lib/jobs/jobs'
import type { JobsDeps, JobsStore } from '../../lib/jobs/types'
import { proposeEdit, reorderState } from '../../lib/review/batches/batch'
import { batchDetail, createBatch } from '../../lib/review/queries'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewDeps, ReviewStore } from '../../lib/review/types'

const editor = { uid: 'editor', name: 'Editor', role: 'editor' } as const
const owner = { uid: 'owner', name: 'Owner', role: 'owner' } as const
const changed: Plate = {
  id: 'AK.p',
  state: 'AK',
  slug: 'p',
  displayName: 'P',
  image: 'p.png',
  tags: ['old'],
  templateRole: 'variant',
  templateFamily: 'gold',
  variantOfPlateId: 'AK.q',
}
const unchanged: Plate = {
  id: 'AK.q',
  state: 'AK',
  slug: 'q',
  displayName: 'Q',
  image: 'q.png',
  tags: ['same'],
  templateRole: 'template',
  templateFamily: 'gold',
}
const released: Plate = {
  ...changed,
  tags: ['old', 'released-in-15'],
  templateRole: 'template',
  templateFamily: 'released',
  variantOfPlateId: null,
}
const catalog: Record<number, Plate[]> = {
  14: [changed, unchanged],
  15: [released, unchanged],
}

/** Register shared baseline-pinning tests against the supplied review and job stores. */
export function batchBaselineScenarios(
  make: () => Promise<{ review: ReviewStore; jobs: JobsStore }>,
  concurrentTimeout?: number
) {
  /**
   * Create a batch against a controlled snapshot and expose a way to advance the live
   * catalog.
   */
  async function setup(version = 14) {
    const stores = await make()
    let live = version
    const deps: ReviewDeps = {
      store: stores.review,
      /** Resolve the plate by ID from the fixture baseline. */
      baseline: async (id) =>
        catalog[live].find((plate) => plate.id === id) ?? null,
      /** Resolve the plate by ID from the fixture baseline. */
      baselineAtVersion: async (at, id) =>
        catalog[at]?.find((plate) => plate.id === id) ?? null,
      /** Return fixture baseline plates belonging to the requested state. */
      stateBaseline: async (at, state) =>
        catalog[at].filter((plate) => plate.state === state),
      /** Pin the operation clock so timestamps and lease checks are reproducible. */
      now: () => '2026-11-17T12:00:00Z',
    }
    const batchId = `baseline-${randomUUID()}`
    expect(
      await createBatch(deps, editor, {
        id: batchId,
        name: 'Review',
        plateIds: [changed.id, unchanged.id],
        baselineVersion: version,
      })
    ).toMatchObject({ ok: true })
    const jobs: JobsDeps = {
      store: stores.jobs,
      baseline: deps.baseline,
      baselineAtVersion: deps.baselineAtVersion,
      /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
        1000,
      id: randomUUID,
      leaseMs: 1000,
    }
    /** Read the current plate from batch detail so tests can inspect its pinned view. */
    async function shown(plateId = changed.id) {
      const detail = await batchDetail(deps, batchId)
      if (!detail.ok) throw new Error(detail.error)
      const plate = detail.value.plates.find(
        (entry) => entry.proposed.id === plateId
      )
      if (!plate) throw new Error('Missing Plate')
      return plate
    }
    /**
     * Apply a worker tag suggestion using the fixture's projected plate and edit
     * revision.
     */
    async function acceptTag() {
      const jobId = randomUUID()
      const job = await createJob(jobs, {
        id: jobId,
        batchId,
        plateId: changed.id,
        requestedBy: editor.uid,
      })
      if (!job.ok) throw new Error(job.error)
      expect(job.value.inputHash).toBe((await shown()).revision)
      const claim = await claimJob(jobs, 'worker', jobId)
      if (!claim.ok) throw new Error(claim.error)
      expect(
        await reportResult(jobs, 'worker', jobId, claim.value.claimId, {
          suggestions: ['suggested'],
          backend: 'local',
          model: 'fixture',
          promptVersion: 'v1',
          durationMs: 1,
        })
      ).toMatchObject({ ok: true })
      return proposeEdit(deps, editor, {
        batchId,
        plateId: changed.id,
        baseRevision: job.value.inputHash,
        fields: { tags: [...job.value.inputPlate!.tags, 'suggested'] },
      })
    }
    return {
      deps,
      batchId,
      shown,
      acceptTag,
      /** Move the test clock forward so deadlines can be reached without waiting. */ advance:
        () => {
          live = 15
        },
    }
  }

  test('changed Plate accepts two shown revisions after the Catalog advances beyond its Batch', async () => {
    const s = await setup()
    s.advance()
    for (const description of ['one', 'two']) {
      const result = await proposeEdit(s.deps, editor, {
        batchId: s.batchId,
        plateId: changed.id,
        baseRevision: (await s.shown()).revision,
        fields: { description },
      })
      expect(result).toMatchObject({
        ok: true,
        value: { plate: { ...changed, description } },
      })
      expect(await s.shown()).toMatchObject({
        baseline: changed,
        proposed: { ...changed, description },
        revision: plateRevision({ ...changed, description }),
      })
    }
    expect(await s.deps.store.getEdit(s.batchId, changed.id)).toMatchObject({
      baseRevision: plateRevision(changed),
      fields: { description: 'two' },
      resultRevision: plateRevision({ ...changed, description: 'two' }),
    })
    expect(await s.deps.store.getBatch(s.batchId)).toMatchObject({
      baselineVersion: 14,
      revision: 2,
    })
  })

  test('completed Tag job inputHash is accepted for a changed Plate in an older Batch', async () => {
    const s = await setup()
    s.advance()
    expect(await s.acceptTag()).toMatchObject({
      ok: true,
      value: { plate: { ...changed, tags: ['old', 'suggested'] } },
    })
    expect(await s.deps.store.getEdit(s.batchId, changed.id)).toMatchObject({
      baseRevision: plateRevision(changed),
      fields: { tags: ['old', 'suggested'] },
    })
    expect((await s.shown()).proposed.tags).toEqual(['old', 'suggested'])
  })

  test('unchanged Plate accepts consecutive saves in an older Batch', async () => {
    const s = await setup()
    s.advance()
    for (const description of ['one', 'two']) {
      expect(
        await proposeEdit(s.deps, editor, {
          batchId: s.batchId,
          plateId: unchanged.id,
          baseRevision: (await s.shown(unchanged.id)).revision,
          fields: { description },
        })
      ).toMatchObject({
        ok: true,
        value: { plate: { ...unchanged, description } },
      })
    }
    expect((await s.shown(unchanged.id)).proposed.description).toBe('two')
  })

  test('fresh Batch at the live version accepts consecutive saves and Tag acceptance', async () => {
    const s = await setup(15)
    for (const description of ['one', 'two']) {
      expect(
        await proposeEdit(s.deps, editor, {
          batchId: s.batchId,
          plateId: changed.id,
          baseRevision: (await s.shown()).revision,
          fields: { description },
        })
      ).toMatchObject({
        ok: true,
        value: { plate: { ...released, description } },
      })
    }
    expect(await s.acceptTag()).toMatchObject({
      ok: true,
      value: {
        plate: {
          ...released,
          description: 'two',
          tags: ['old', 'released-in-15', 'suggested'],
        },
      },
    })
  })

  test(
    'real concurrent edits conflict within the older Batch and Reapply converges',
    async () => {
      const s = await setup()
      s.advance()
      const input = {
        batchId: s.batchId,
        plateId: changed.id,
        baseRevision: (await s.shown()).revision,
      }
      const results = await Promise.all([
        proposeEdit(s.deps, editor, {
          ...input,
          fields: { description: 'first' },
        }),
        proposeEdit(s.deps, owner, {
          ...input,
          fields: { description: 'second' },
        }),
      ])
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      const conflict = results.find((result) => !result.ok)
      expect(conflict).toMatchObject({
        ok: false,
        error: 'stale_plate',
        current: { tags: changed.tags },
      })
      if (!conflict || conflict.ok || !conflict.current)
        throw new Error('Expected conflict')
      const loser = results[0].ok
        ? { actor: owner, description: 'second' }
        : { actor: editor, description: 'first' }
      expect(
        await proposeEdit(s.deps, loser.actor, {
          ...input,
          baseRevision: plateRevision(conflict.current),
          fields: { description: loser.description },
        })
      ).toMatchObject({ ok: true })
      expect((await s.shown()).proposed).toEqual({
        ...changed,
        description: loser.description,
      })
      expect(
        await proposeEdit(s.deps, loser.actor, {
          ...input,
          baseRevision: (await s.shown()).revision,
          fields: { description: 'after reapply' },
        })
      ).toMatchObject({ ok: true })
      expect(await s.deps.store.getBatch(s.batchId)).toMatchObject({
        revision: 3,
        baselineVersion: 14,
      })
    },
    concurrentTimeout
  )

  test('combined promotion uses the Batch baseline after the live Plate becomes a template', async () => {
    const s = await setup()
    s.advance()
    const fields = {
      templateRole: 'template' as const,
      templateFamily: 'promoted',
      variantOfPlateId: null,
    }
    expect(
      await reorderState(s.deps, editor, {
        batchId: s.batchId,
        state: 'AK',
        batchRevision: 0,
        order: [unchanged.id, changed.id],
        promotion: { plateId: changed.id, templateFamily: 'promoted' },
        standard: { from: null, to: unchanged.id },
      })
    ).toMatchObject({
      ok: true,
      value: { revision: 1, stateOrders: { AK: [unchanged.id, changed.id] } },
    })
    expect(await s.deps.store.getEdit(s.batchId, changed.id)).toMatchObject({
      baseRevision: plateRevision(changed),
      fields,
      resultRevision: plateRevision({ ...changed, ...fields }),
    })
    expect((await s.shown()).proposed).toEqual({ ...changed, ...fields })
    expect(
      await proposeEdit(s.deps, editor, {
        batchId: s.batchId,
        plateId: changed.id,
        baseRevision: (await s.shown()).revision,
        fields: { description: 'after promotion' },
      })
    ).toMatchObject({ ok: true })
  })

  test('a Plate missing from the pinned snapshot returns not_found without a live fallback', async () => {
    const s = await setup()
    s.advance()
    s.deps.baselineAtVersion = async () => null
    expect(
      await proposeEdit(s.deps, editor, {
        batchId: s.batchId,
        plateId: changed.id,
        baseRevision: plateRevision(released),
        fields: { description: 'live only' },
      })
    ).toEqual({ ok: false, error: 'not_found' })
    expect(await s.deps.store.getEdit(s.batchId, changed.id)).toBeNull()
    expect(await s.deps.store.getBatch(s.batchId)).toMatchObject({
      revision: 0,
    })
  })

  test('an unavailable pinned snapshot fails the save without using the live Catalog', async () => {
    const s = await setup()
    s.advance()
    s.deps.baselineAtVersion = async () => {
      throw new Error('Baseline catalog version unavailable')
    }
    await expect(
      proposeEdit(s.deps, editor, {
        batchId: s.batchId,
        plateId: changed.id,
        baseRevision: plateRevision(released),
        fields: { description: 'live only' },
      })
    ).rejects.toThrow('Baseline catalog version unavailable')
    expect(await s.deps.store.getEdit(s.batchId, changed.id)).toBeNull()
    expect(await s.deps.store.getBatch(s.batchId)).toMatchObject({
      revision: 0,
    })
  })
}

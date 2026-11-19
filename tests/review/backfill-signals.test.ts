import { expect, test } from 'vitest'
import {
  backfillBatchSignals,
  type BatchSignalsBackfillStore,
} from '../../lib/review/signals/backfill-signals'

test('backfill guards staging before using its store', async () => {
  /** Fail if an invalid staging target reaches the backfill store. */
  const unused = () => {
    throw new Error('Store must not be used')
  }
  for (const projectId of [undefined, 'demo-plate-curator', 'other-project']) {
    await expect(
      backfillBatchSignals(
        { listBatchIds: unused, initializeMissing: unused },
        { projectId, env: 'development' }
      )
    ).rejects.toThrow('staging')
  }
})

test('backfill initializes only missing current environment signals and is repeatable', async () => {
  const batches = new Map([
    ['one', { env: 'preview:feat/x', revision: 4 }],
    ['existing', { env: 'preview:feat/x', revision: 8 }],
    ['other', { env: 'development', revision: 2 }],
  ])
  const signals = new Map([['preview:feat/x/existing', 7]])
  const store: BatchSignalsBackfillStore = {
    /**
     * Return IDs for the requested fixture environment so the backfill cannot touch
     * other drafts.
     */
    listBatchIds: async (env) =>
      [...batches].filter(([, batch]) => batch.env === env).map(([id]) => id),
    /**
     * Initialize a missing fixture signal with the batch's current revision and preserve
     * existing signals.
     */
    initializeMissing: async (id, env) => {
      const batch = batches.get(id)
      const key = `${env}/${id}`
      if (!batch || batch.env !== env || signals.has(key)) return false
      signals.set(key, batch.revision)
      return true
    },
  }
  const input = {
    projectId: 'license-plate-game-staging',
    env: 'preview:feat/x',
  }
  expect(await backfillBatchSignals(store, input)).toEqual({
    scanned: 2,
    initialized: 1,
  })
  expect(signals).toEqual(
    new Map([
      ['preview:feat/x/existing', 7],
      ['preview:feat/x/one', 4],
    ])
  )
  expect(await backfillBatchSignals(store, input)).toEqual({
    scanned: 2,
    initialized: 0,
  })
})

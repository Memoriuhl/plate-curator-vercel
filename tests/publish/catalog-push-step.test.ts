import { expect, test, vi } from 'vitest'
import { catalogPush } from '../../workflows/catalog-push'

vi.mock('../../lib/server/context', () => ({ catalogPushDeps: () => { throw new Error('Missing configuration') } }))

test('configuration failure returns a best effort step outcome', async () => {
  expect(await catalogPush(8)).toEqual({ status: 'unavailable', sent: 0, failed: 0, pruned: 0 })
})

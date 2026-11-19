import { expect } from 'vitest'
import type { JobsStore } from '../../lib/jobs/types'

/** The wake ledger contract every jobs store with a ledger must meet. */
export async function wakeLedgerScenario(store: JobsStore) {
  const claimWake = store.claimWake!.bind(store)
  const settleWake = store.settleWake!.bind(store)
  const hold = 15_000

  expect(await claimWake('run', 'report', 100, hold)).toBe(true)
  // A second sender for the same transition skips while the first one holds it.
  expect(await claimWake('run', 'report', 200, hold)).toBe(false)

  // A failed send hands the wake to the next sender at once.
  await settleWake('run', 'report', false)
  expect(await claimWake('run', 'report', 300, hold)).toBe(true)

  // A delivered wake is never sent again for that transition, however late.
  await settleWake('run', 'report', true)
  expect(await claimWake('run', 'report', 100 + 24 * 60 * 60_000, hold)).toBe(
    false
  )

  // A newer transition takes the ledger, and a sender that went quiet loses its hold.
  expect(await claimWake('run', 'next', 400, hold)).toBe(true)
  expect(await claimWake('run', 'next', 400 + hold - 1, hold)).toBe(false)
  expect(await claimWake('run', 'next', 400 + hold, hold)).toBe(true)

  // A late outcome for an older transition leaves the newer one alone.
  await settleWake('run', 'report', false)
  expect(await claimWake('run', 'next', 401 + hold, hold)).toBe(false)

  // Runs keep separate ledgers.
  expect(await claimWake('other-run', 'report', 500, hold)).toBe(true)
}

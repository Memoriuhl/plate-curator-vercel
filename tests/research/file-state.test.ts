import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fileResearchState } from '../../lib/research/stores/file-state'
import { reserveResearchSpend } from '../../lib/research/budget'

test('independent local state instances cannot race past the shared paid-call cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'research-state-'))
  try {
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, index) =>
        reserveResearchSpend(
          fileResearchState(directory),
          'campaign',
          `run-${index}`,
          'model',
          0.2,
          2
        )
      )
    )
    expect(results.filter(Boolean)).toHaveLength(10)
    expect(
      await fileResearchState(directory).read('budget/campaign')
    ).toMatchObject({ committedMicros: 2000000 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

import { expect, test } from 'vitest'
import { POST as approve } from '../../app/api/batches/[id]/approve/route'
import { POST as copy } from '../../app/api/batches/[id]/copy/route'
import { POST as submit } from '../../app/api/batches/[id]/submit/route'

test.each([
  ['submit', submit],
  ['approve', approve],
  ['copy', copy],
] as const)(
  'the retired %s step answers 410 and points at the shared draft',
  async (_, handler) => {
    const response = handler()
    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({
      error: 'batches_retired',
      message:
        'Batches were replaced by one shared draft. Edit the draft; the Owner publishes it.',
    })
  }
)

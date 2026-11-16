import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ batches: vi.fn(), batch: vi.fn() }))
vi.mock('../lib/client/hooks', () => ({
  useBatches: mocks.batches,
  useBatch: mocks.batch,
}))
import { useFamilyBatchOverlay } from '../components/dashboard/family-grid'
function Probe() {
  return <p>{JSON.stringify([...useFamilyBatchOverlay()])}</p>
}
test('overlay uses the current open batch and only edited plates with their authors', () => {
  mocks.batches.mockReturnValue({ data: [{ id: 'mine' }] })
  mocks.batch.mockReturnValue({
    data: {
      plates: [
        { proposed: { id: 'changed' }, edit: { authorId: 'curator' } },
        { proposed: { id: 'unchanged' }, edit: null },
      ],
    },
  })
  const html = renderToStaticMarkup(<Probe />)
  expect(mocks.batches).toHaveBeenCalledWith(['open'], { mine: true })
  expect(mocks.batch).toHaveBeenCalledWith('mine')
  expect(html).toContain('changed')
  expect(html).toContain('curator')
  expect(html).not.toContain('unchanged')
})
test('overlay tolerates a signed out user or a pending batch', () => {
  mocks.batches.mockReturnValue({})
  mocks.batch.mockReturnValue({})
  expect(renderToStaticMarkup(<Probe />)).toContain('[]')
  expect(mocks.batch).toHaveBeenLastCalledWith(null)
})

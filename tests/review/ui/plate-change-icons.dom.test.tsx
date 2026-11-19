import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { PlateChangeIcons } from '../../../components/review/plate-change-icons'
import type { BatchDetail } from '../../../lib/client/hooks'

const baseline = {
  id: 'AK.army',
  state: 'AK',
  slug: 'army',
  displayName: 'Army',
  tags: ['army'],
  image: 'AK/army.webp',
}
const entry: BatchDetail['plates'][number] = {
  baseline,
  proposed: {
    ...baseline,
    description: 'Honors soldiers.',
    readMore: [{ title: 'A', site: 'a.test', url: 'https://a.test' }],
  },
  edit: null,
  revision: 'r',
}

test('hovering a change icon shows what changed', async () => {
  render(<PlateChangeIcons entry={entry} />)
  const description = screen.getByRole('img', { name: 'Description changed' })
  fireEvent.pointerMove(description)
  const tooltip = await screen.findByRole('tooltip')
  expect(tooltip.textContent).toContain('Added: Honors soldiers.')
})

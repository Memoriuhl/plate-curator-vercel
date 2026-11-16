import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import Home from '../app/(curator)/page'
import { dashboardFixture } from '../fixtures/dashboard-frame'

vi.mock('../lib/catalog/dashboard', () => ({
  loadDashboard: async () => dashboardFixture,
}))
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`Redirect ${path}`)
  },
}))
vi.mock('next/server', () => ({ connection: async () => undefined }))

test('home page keeps a static loading frame while selecting the first jurisdiction', async () => {
  const html = renderToStaticMarkup(<Home />)
  expect(html).toContain('Loading state')
  const content = Home().props.children.props.children
  await expect(content.type()).rejects.toThrow('Redirect /states/AK')
})

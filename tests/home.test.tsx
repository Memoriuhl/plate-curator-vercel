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
  const props = { searchParams: Promise.resolve({}) }
  const html = renderToStaticMarkup(<Home {...props} />)
  expect(html).toContain('Loading state')
  const content = Home(props).props.children.props.children
  await expect(content.type(content.props)).rejects.toThrow('Redirect /states/AK')
})

test('Dashboard redirects to the first jurisdiction with the requested Batch', async () => {
  const content = Home({ searchParams: Promise.resolve({ batch: 'fixture%3Ashared' }) }).props.children.props.children
  await expect(content.type(content.props)).rejects.toThrow('Redirect /states/AK?batch=fixture%253Ashared')
})

import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import Home from '../app/(curator)/page'

test('home page presents the product name as its main heading', () => {
  const html = renderToStaticMarkup(<Home />)
  expect(html).toContain('<h1 class="page-title">Plate Curator</h1>')
})

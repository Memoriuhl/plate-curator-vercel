import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import Home from '../app/page'

test('home page presents the product name as its main heading', () => {
  const html = renderToStaticMarkup(<Home />)
  expect(html).toContain('<h1>Plate Curator</h1>')
})

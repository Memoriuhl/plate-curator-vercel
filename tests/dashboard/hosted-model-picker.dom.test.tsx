import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HostedModelPicker } from '../../components/dashboard/hosted-model-picker'
import type { HostedModelCatalog } from '../../lib/models/selection'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const catalog: HostedModelCatalog = {
  curated: [
    {
      id: 'google/gemma-4-26b-a4b-it',
      label: 'Gemma 4 26B',
      provider: 'google',
      estimatedUsd: 0.0003,
    },
    {
      id: 'google/gemini-2.5-flash-lite',
      label: 'Gemini 2.5 Flash Lite',
      provider: 'google',
      estimatedUsd: 0.0006,
    },
  ],
  searchable: [],
  caps: [0.01],
}
const local = [{ id: 'ollama:gemma4:26b', label: 'Gemma 4 26B' }]

/** Render the picker with one on-device and two hosted models. */
function renderPicker(selected = local[0]) {
  render(
    <HostedModelPicker
      label="Research model"
      catalog={catalog}
      localModels={local}
      selected={selected}
      options={{ capUsd: 0.01, strict: false }}
      onChange={vi.fn()}
      onOptionsChange={vi.fn()}
    />
  )
  return screen.getByRole('button', { name: /^Research model:/ })
}

test('on-device workers come first, then the curated hosted models', () => {
  fireEvent.click(renderPicker())
  const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map(
    (heading) => heading.textContent
  )
  expect(headings).toEqual(['On-device workers', 'Curated'])
  expect(
    [...document.querySelectorAll('[cmdk-item]')].map(
      (option) => option.textContent
    )
  ).toEqual([
    expect.stringContaining('Gemma 4 26B'),
    expect.stringContaining('Gemma 4 26B'),
    expect.stringContaining('Gemini 2.5 Flash Lite'),
  ])
})

test('every option shows where it runs: a computer for on-device, a cloud for hosted', () => {
  fireEvent.click(renderPicker())
  expect(
    [...document.querySelectorAll('[cmdk-item]')].map((option) =>
      option.querySelector('[data-model-host]')?.getAttribute('data-model-host')
    )
  ).toEqual(['device', 'cloud', 'cloud'])
})

test('the picker button shows where the selected model runs', () => {
  expect(
    renderPicker()
      .querySelector('[data-model-host]')
      ?.getAttribute('data-model-host')
  ).toBe('device')
  cleanup()
  expect(
    renderPicker({ id: catalog.curated[0].id, label: 'Gemma 4 26B' })
      .querySelector('[data-model-host]')
      ?.getAttribute('data-model-host')
  ).toBe('cloud')
})

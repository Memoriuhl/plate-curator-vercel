import { expect, test } from 'vitest'
import { DROP_DURATION, SPRING_SAMPLES, entranceDelay, familyColumns, hoverPosition } from '../components/dashboard/grid-feel'

test.each([[399, 1], [400, 1], [815, 1], [816, 2], [1024, 2], [1231, 2], [1232, 3], [1280, 3], [1440, 3], [1648, 4]])('columns at %i pixels of container width', (width, columns) => {
  expect(familyColumns(width)).toBe(columns)
})

test('spring starts at zero, overshoots and settles to one', () => {
  expect(SPRING_SAMPLES[0]).toBe(0)
  expect(Math.max(...SPRING_SAMPLES)).toBeGreaterThan(1)
  expect(SPRING_SAMPLES.at(-1)).toBe(1)
  expect(DROP_DURATION).toBeGreaterThan(850)
  expect(DROP_DURATION).toBeLessThan(950)
})

test('row and column delays cap rows at slot fourteen', () => {
  expect(entranceDelay(0, 0)).toBe(0)
  expect(entranceDelay(1, 0)).toBe(55)
  expect(entranceDelay(1, 1)).toBe(85)
  expect(entranceDelay(14, 4)).toBe(890)
  expect(entranceDelay(80, 4)).toBe(890)
})

test('preview sits right of its anchor with an eight pixel gap', () => {
  expect(hoverPosition({ left: 100, right: 240, top: 120 }, 372, 300, 1440, 900)).toEqual({ left: 248, top: 120 })
})

test('preview flips left near the right viewport edge', () => {
  expect(hoverPosition({ left: 1200, right: 1340, top: 120 }, 372, 300, 1440, 900)).toEqual({ left: 820, top: 120 })
})

test('preview clamps at the bottom using its measured height', () => {
  expect(hoverPosition({ left: 100, right: 240, top: 800 }, 372, 300, 1440, 900).top).toBe(592)
  expect(hoverPosition({ left: 100, right: 240, top: 800 }, 372, 600, 1440, 900).top).toBe(292)
  expect(hoverPosition({ left: 2, right: 142, top: -20 }, 372, 884, 400, 900)).toEqual({ left: 8, top: 8 })
})

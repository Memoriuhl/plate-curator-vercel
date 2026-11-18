import { expect, test } from 'vitest'
import {
  DROP_DURATION,
  SPRING_SAMPLES,
  entranceDelay,
  familyColumns,
  FAMILY_MIN_COLUMN_WIDTH,
  hoverPosition,
} from '../components/dashboard/grid-feel'

test.each([
  [319, 1],
  [559, 1],
  [560, 2],
  [847, 2],
  [848, 3],
  [1135, 3],
  [1136, 4],
  [1287, 4],
  [1423, 4],
  [1424, 5],
])('columns at %i pixels of container width', (width, columns) => {
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
  expect(
    hoverPosition({ left: 100, right: 240, top: 120 }, 372, 300, 1440, 900)
  ).toEqual({ left: 248, top: 120 })
})

test('preview flips left near the right viewport edge', () => {
  expect(
    hoverPosition({ left: 1200, right: 1340, top: 120 }, 372, 300, 1440, 900)
  ).toEqual({ left: 820, top: 120 })
})

test('preview clamps at the bottom using its measured height', () => {
  expect(
    hoverPosition({ left: 100, right: 240, top: 800 }, 372, 300, 1440, 900).top
  ).toBe(592)
  expect(
    hoverPosition({ left: 100, right: 240, top: 800 }, 372, 600, 1440, 900).top
  ).toBe(292)
  expect(
    hoverPosition({ left: 2, right: 142, top: -20 }, 372, 884, 400, 900)
  ).toEqual({ left: 8, top: 8 })
})

test('family cards use a 272px minimum column width', () => {
  expect(FAMILY_MIN_COLUMN_WIDTH).toBe(272)
})

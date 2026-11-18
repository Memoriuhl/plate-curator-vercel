export const FAMILY_MIN_COLUMN_WIDTH = 272
export const FAMILY_COLUMN_GAP = 16

export function familyColumns(width: number) {
  return Math.max(1, Math.floor((width + FAMILY_COLUMN_GAP) / (FAMILY_MIN_COLUMN_WIDTH + FAMILY_COLUMN_GAP)))
}

export function entranceDelay(row: number, column: number) {
  return Math.min(Math.max(0, row), 14) * 55 + Math.max(0, column) * 30
}

const decay = 11 / 2
const frequency = Math.sqrt(170 - decay * decay)
export const DROP_DURATION = Math.ceil((-Math.log(0.007) / decay) * 1000)
export const SPRING_SAMPLES = Array.from({ length: 91 }, (_, index) => {
  if (index === 0) return 0
  if (index === 90) return 1
  const seconds = (index / 90) * DROP_DURATION / 1000
  return 1 - Math.exp(-decay * seconds) * (Math.cos(frequency * seconds) + decay / frequency * Math.sin(frequency * seconds))
})
export const DROP_EASING = `linear(${SPRING_SAMPLES.map(value => value.toFixed(5)).join(', ')})`

export function hoverPosition(anchor: Pick<DOMRect, 'left' | 'right' | 'top'>, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const right = anchor.right + 8
  return {
    left: Math.max(8, Math.min(right + width <= viewportWidth - 8 ? right : anchor.left - width - 8, viewportWidth - width - 8)),
    top: Math.max(8, Math.min(anchor.top, viewportHeight - height - 8)),
  }
}

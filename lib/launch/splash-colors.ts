/*
 * The launch splash is drawn before the theme is known and looks the same in
 * light and dark mode (the design's dark ground), so these are its fixed
 * colours, straight from the design (State Spotter launch splash), not theme tokens.
 */

/** The dark ground; also the native splash's background in app.json. */
export const SPLASH_GROUND = '#15201B'

/** The blank icon plate: white face, dark inset ring and bolts. */
export const PLATE_FACE = '#FFFFFF'
export const PLATE_INK = '#15201B'

export const SPLASH_SHADOW = '#000000'
export const CHECK_GREEN = '#17B26A'
export const CHECK_RING = '#FFFFFF'

/** Mode colours plus white and the check green: "every game, spotted". */
export const CONFETTI_COLORS = [
  '#0E6B45',
  '#C2362B',
  '#1F4FA3',
  '#F7B500',
  '#FFFFFF',
  '#17B26A',
] as const

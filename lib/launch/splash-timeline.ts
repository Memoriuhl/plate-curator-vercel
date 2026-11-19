/**
 * The "Spotted" launch splash, as plain data: when the blank icon plate enters,
 * shakes, squashes and jumps, when the check and confetti pop, when the app is
 * revealed, and the poses in between. launch-splash.tsx only schedules these
 * and draws them.
 *
 * Every constant and keyframe is the design's (Spotted.dc.html).
 */

import { CONFETTI_COLORS } from './splash-colors'

/** The plate fades and scales in over this long. */
export const ENTER_MS = 450
/** The full build: the shake, growing, ending in a squash. */
export const BUILD_MS = 2100
/** The build is a shake up to here (back at rest), then the squash. */
export const SHAKE_END = 0.84
export const SHAKE_MS = Math.round(BUILD_MS * SHAKE_END)
export const SQUASH_MS = BUILD_MS - SHAKE_MS
/** A slow boot wobbles on the build's first, gentlest segment (0–18%), looping. */
export const WOBBLE_END = 0.18
export const WOBBLE_MS = Math.round(BUILD_MS * WOBBLE_END)
/** Easing a wobble back to rest once the app is ready. */
export const WOBBLE_SETTLE_MS = 120
export const JUMP_MS = 500
/** The check, the ring and the confetti land on the peak of the jump. */
export const SPOTTED_AFTER_JUMP_MS = 140
/** From the pop to the reveal. */
export const SPOTTED_HOLD_MS = 1150
export const RING_MS = 600
/** Reduced motion: the check fades in, holds briefly, then a quick fade reveal. */
export const REDUCED_CHECK_FADE_MS = 200
export const REDUCED_HOLD_MS = 600
export const REDUCED_FADE_MS = 250
/** The cover unzips upward over this long while the plate flies off. */
export const UNZIP_MS = 800
export const FLY_OUT_MS = 600
/** The design unmounts the cover a beat after the unzip ends. */
export const REVEAL_DONE_MS = 900
/**
 * A boot that never reports ready (a failed DB open) must not trap the player
 * on the wobble: past this, the splash pops and reveals whatever is there.
 */
export const BOOT_WAIT_CAP_MS = 8000

/**
 * - `intro`: the first launch after install; enter, the full shaking build, pop.
 * - `still`: every later cold launch; enter, then straight to the pop.
 * - `reduced`: reduced motion; no shake, no confetti, the check fades in.
 */
export type SplashVariant = 'intro' | 'still' | 'reduced'

/** The variant a cold launch plays. */
export function chooseSplashVariant({
  introSeen,
  reduceMotion,
}: {
  introSeen: boolean
  reduceMotion: boolean
}): SplashVariant {
  if (reduceMotion) return 'reduced'
  return introSeen ? 'still' : 'intro'
}

/*
 * A launch runs in two parts. The lead-in plays regardless of the app; at its
 * end the splash decides: a ready app gets the pop at once, a booting one
 * wobbles until it is ready. The pop then runs to the reveal.
 */

export type LeadInStep = 'enter' | 'shake' | 'decide'
export type PopStep = 'squash' | 'jump' | 'spotted' | 'check' | 'reveal'
export interface Scheduled<S> {
  atMs: number
  step: S
}

/** The lead-in, in ms after the splash starts; it ends on `decide`. */
export function leadInScript(variant: SplashVariant): Scheduled<LeadInStep>[] {
  if (variant === 'reduced') return [{ atMs: 0, step: 'decide' }]
  const steps: Scheduled<LeadInStep>[] = [{ atMs: 0, step: 'enter' }]
  if (variant === 'still') return [...steps, { atMs: ENTER_MS, step: 'decide' }]
  return [
    ...steps,
    { atMs: ENTER_MS, step: 'shake' },
    { atMs: ENTER_MS + SHAKE_MS, step: 'decide' },
  ]
}

/**
 * Once ready: the pop, in ms after it starts. The build's squash winds the
 * plate up (a later launch gets just the squash, no shake), it jumps, and the
 * check, ring and confetti land on the jump's peak.
 */
export function popScript(variant: SplashVariant): Scheduled<PopStep>[] {
  if (variant === 'reduced') {
    return [
      { atMs: 0, step: 'check' },
      { atMs: REDUCED_HOLD_MS, step: 'reveal' },
    ]
  }
  const spotted = SQUASH_MS + SPOTTED_AFTER_JUMP_MS
  return [
    { atMs: 0, step: 'squash' },
    { atMs: SQUASH_MS, step: 'jump' },
    { atMs: spotted, step: 'spotted' },
    { atMs: spotted + SPOTTED_HOLD_MS, step: 'reveal' },
  ]
}

/** At the decision: pop a ready app, keep a booting one wobbling until it's ready. */
export function afterLeadIn(appReady: boolean): 'pop' | 'wobble' {
  return appReady ? 'pop' : 'wobble'
}

/** How long a launch takes to reveal a ready app: the splash never holds it longer. */
export function minimumSplashMs(variant: SplashVariant): number {
  const lead = leadInScript(variant)
  const pop = popScript(variant)
  return lead[lead.length - 1].atMs + pop[pop.length - 1].atMs
}

/** The reveal is a fade under reduced motion, else the unzip and the plate flying off. */
export function revealMs(variant: SplashVariant): number {
  return variant === 'reduced' ? REDUCED_FADE_MS : REVEAL_DONE_MS
}

/** The plate's pose: translate, rotation (deg) and per-axis scale. */
export interface PlatePose {
  x: number
  y: number
  deg: number
  sx: number
  sy: number
}

/** The build keyframes, [progress, x, deg, scale], linear between them. */
const BUILD_KEYS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 1],
  [0.09, 0, 1.5, 1],
  [0.12, 0, -1.5, 1],
  [0.15, 0, 1.2, 1],
  [0.18, 0, 0, 1],
  [0.32, 2, 3, 1],
  [0.35, -2, -3, 1],
  [0.38, 3, 3.5, 1],
  [0.41, -2, -3, 1],
  [0.44, 0, 0, 1],
  [0.56, 4, 5, 1.01],
  [0.59, -4, -5.5, 1.02],
  [0.62, 5, 6, 1.02],
  [0.65, -5, -6.5, 1.03],
  [0.68, 5, 6.5, 1.03],
  [0.71, -4, -6, 1.03],
  [0.74, 3, 5, 1.03],
  [0.77, -3, -4, 1.03],
  [0.8, 2, 3, 1.03],
  [SHAKE_END, 0, 0, 1],
]
/** The squash the build ends in (and the jump starts from). */
export const SQUASH_POSE: PlatePose = {
  x: 0,
  y: 10,
  deg: 0,
  sx: 1.08,
  sy: 0.86,
}
export const REST_POSE: PlatePose = { x: 0, y: 0, deg: 0, sx: 1, sy: 1 }

/** The plate's pose `p` (0–1) through the build. */
export function buildPose(p: number): PlatePose {
  const t = Math.min(1, Math.max(0, p))
  if (t >= SHAKE_END) {
    const k = (t - SHAKE_END) / (1 - SHAKE_END)
    return {
      x: 0,
      y: SQUASH_POSE.y * k,
      deg: 0,
      sx: 1 + (SQUASH_POSE.sx - 1) * k,
      sy: 1 + (SQUASH_POSE.sy - 1) * k,
    }
  }
  let i = 0
  while (i < BUILD_KEYS.length - 2 && BUILD_KEYS[i + 1][0] <= t) i++
  const a = BUILD_KEYS[i]
  const b = BUILD_KEYS[i + 1]
  const k = (t - a[0]) / (b[0] - a[0])
  const s = a[3] + (b[3] - a[3]) * k
  return {
    x: a[1] + (b[1] - a[1]) * k,
    y: 0,
    deg: a[2] + (b[2] - a[2]) * k,
    sx: s,
    sy: s,
  }
}

/**
 * A CSS cubic-bezier timing function, for the animation frame loop. Solves x(t) by
 * Newton's method with a bisection fallback.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = ((ax * t + bx) * t + cx) * t - x
      if (Math.abs(err) < 1e-5) return ((ay * t + by) * t + cy) * t
      const d = (3 * ax * t + 2 * bx) * t + cx
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    let lo = 0
    let hi = 1
    t = x
    for (let i = 0; i < 30; i++) {
      const v = ((ax * t + bx) * t + cx) * t
      if (Math.abs(v - x) < 1e-5) break
      if (v < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return ((ay * t + by) * t + cy) * t
  }
}

export const CONFETTI_COUNT = 30

/** One confetti bit's flight, fixed when the burst is made. */
export interface ConfettiBit {
  /** The peak of its burst, then where it ends up after falling (px from the plate's centre). */
  x: number
  y: number
  x2: number
  y2: number
  /** Spin (deg) at the peak and at the end. */
  r: number
  r2: number
  w: number
  h: number
  radius: number
  color: string
  /** Its own flight time and start delay (ms). */
  t: number
  delay: number
}

/** A burst of `n` bits: mostly an upward fan out of the plate's top, then a fall. */
export function makeConfetti(
  n: number = CONFETTI_COUNT,
  rand: () => number = Math.random
) {
  const bits: ConfettiBit[] = []
  for (let i = 0; i < n; i++) {
    const a = ((-90 + (rand() * 2 - 1) * 80) * Math.PI) / 180
    const dist = 110 + rand() * 120
    const x = Math.round(Math.cos(a) * dist)
    const y = Math.round(Math.sin(a) * dist - 40)
    const r = Math.round((rand() * 2 - 1) * 360)
    const strip = rand() < 0.6
    bits.push({
      x,
      y,
      x2: Math.round(x * 1.25 + (rand() * 2 - 1) * 30),
      y2: Math.round(y + 220 + rand() * 120),
      r,
      r2: Math.round(r + (rand() < 0.5 ? -1 : 1) * (240 + rand() * 360)),
      w: strip ? 7 : 9,
      h: strip ? 14 : 9,
      radius: strip ? 2 : 5,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      t: Math.round(1200 + rand() * 500),
      delay: Math.round(rand() * 80),
    })
  }
  return bits
}

/** How long a burst runs: its slowest bit's delay plus flight. Nothing renders after. */
export function confettiMs(bits: readonly ConfettiBit[]): number {
  return bits.reduce((m, b) => Math.max(m, b.delay + b.t), 0)
}

const BIT_UP = cubicBezier(0.1, 0.75, 0.3, 1)
const BIT_FALL = cubicBezier(0.4, 0, 0.8, 0.6)
/** The bit's keyframes put its peak here, through its flight. */
const BIT_PEAK = 0.45

export interface BitPose {
  x: number
  y: number
  deg: number
  scale: number
  opacity: number
}

/** Where a bit is `ms` after the burst starts. Before its delay it waits, small, at the centre. */
export function bitPose(bit: ConfettiBit, ms: number): BitPose {
  const p = Math.min(1, Math.max(0, (ms - bit.delay) / bit.t))
  if (p <= BIT_PEAK) {
    const k = BIT_UP(p / BIT_PEAK)
    return {
      x: bit.x * k,
      y: bit.y * k,
      deg: bit.r * k,
      scale: 0.3 + 0.7 * k,
      opacity: 1,
    }
  }
  const k = BIT_FALL((p - BIT_PEAK) / (1 - BIT_PEAK))
  return {
    x: bit.x + (bit.x2 - bit.x) * k,
    y: bit.y + (bit.y2 - bit.y) * k,
    deg: bit.r + (bit.r2 - bit.r) * k,
    scale: 1 - 0.1 * k,
    opacity: 1 - k,
  }
}

import { describe, expect, it } from 'vitest'

import { CONFETTI_COLORS } from '@/lib/launch/splash-colors'
import {
  BUILD_MS,
  CONFETTI_COUNT,
  ENTER_MS,
  JUMP_MS,
  REDUCED_FADE_MS,
  REDUCED_HOLD_MS,
  REST_POSE,
  REVEAL_DONE_MS,
  SHAKE_END,
  SHAKE_MS,
  SPOTTED_AFTER_JUMP_MS,
  SPOTTED_HOLD_MS,
  SQUASH_MS,
  SQUASH_POSE,
  WOBBLE_END,
  afterLeadIn,
  bitPose,
  buildPose,
  chooseSplashVariant,
  confettiMs,
  cubicBezier,
  leadInScript,
  makeConfetti,
  minimumSplashMs,
  popScript,
  revealMs,
} from '@/lib/launch/splash-timeline'

/** A repeatable stand-in for Math.random. */
function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

describe('chooseSplashVariant', () => {
  it('plays the intro on the first launch after install, the still pop after', () => {
    expect(chooseSplashVariant({ introSeen: false, reduceMotion: false })).toBe(
      'intro'
    )
    expect(chooseSplashVariant({ introSeen: true, reduceMotion: false })).toBe(
      'still'
    )
  })

  it('skips the shake and confetti under reduced motion, first launch or not', () => {
    expect(chooseSplashVariant({ introSeen: false, reduceMotion: true })).toBe(
      'reduced'
    )
    expect(chooseSplashVariant({ introSeen: true, reduceMotion: true })).toBe(
      'reduced'
    )
  })
})

describe('leadInScript', () => {
  it('intro: enters, shakes through the build up to the squash, then decides', () => {
    expect(leadInScript('intro')).toEqual([
      { atMs: 0, step: 'enter' },
      { atMs: ENTER_MS, step: 'shake' },
      { atMs: ENTER_MS + SHAKE_MS, step: 'decide' },
    ])
  })

  it('still: enters, then decides with no shake', () => {
    expect(leadInScript('still')).toEqual([
      { atMs: 0, step: 'enter' },
      { atMs: ENTER_MS, step: 'decide' },
    ])
  })

  it('reduced: decides at once', () => {
    expect(leadInScript('reduced')).toEqual([{ atMs: 0, step: 'decide' }])
  })
})

describe('popScript', () => {
  it('squashes, jumps, lands the check and confetti 140ms into the jump, holds, reveals', () => {
    expect(popScript('intro')).toEqual([
      { atMs: 0, step: 'squash' },
      { atMs: SQUASH_MS, step: 'jump' },
      { atMs: SQUASH_MS + SPOTTED_AFTER_JUMP_MS, step: 'spotted' },
      {
        atMs: SQUASH_MS + SPOTTED_AFTER_JUMP_MS + SPOTTED_HOLD_MS,
        step: 'reveal',
      },
    ])
    expect(popScript('still')).toEqual(popScript('intro'))
  })

  it('reduced: the check fades in, a brief hold, the reveal; no jump or confetti', () => {
    const steps = popScript('reduced').map((s) => s.step)
    expect(steps).toEqual(['check', 'reveal'])
    expect(popScript('reduced')[1].atMs).toBe(REDUCED_HOLD_MS)
  })

  it('runs every script in time order', () => {
    for (const v of ['intro', 'still', 'reduced'] as const) {
      for (const script of [leadInScript(v), popScript(v)]) {
        const times = script.map((s) => s.atMs)
        expect([...times].sort((a, b) => a - b)).toEqual(times)
      }
    }
  })
})

describe('timing', () => {
  it('splits the 2.1s build into the shake and the squash', () => {
    expect(SHAKE_MS + SQUASH_MS).toBe(BUILD_MS)
    expect(JUMP_MS).toBe(500)
  })

  it('reveals a ready app on the design schedule: 3.84s for the intro', () => {
    // Design: enter 450 + build 2100 + 140 + 1150.
    expect(minimumSplashMs('intro')).toBe(450 + 2100 + 140 + 1150)
    expect(minimumSplashMs('still')).toBe(ENTER_MS + SQUASH_MS + 140 + 1150)
    expect(minimumSplashMs('reduced')).toBeLessThan(minimumSplashMs('still'))
  })

  it('pops a ready app and wobbles a booting one', () => {
    expect(afterLeadIn(true)).toBe('pop')
    expect(afterLeadIn(false)).toBe('wobble')
  })

  it('fades under reduced motion and unzips otherwise', () => {
    expect(revealMs('reduced')).toBe(REDUCED_FADE_MS)
    expect(revealMs('intro')).toBe(REVEAL_DONE_MS)
  })
})

describe('buildPose', () => {
  it('starts and ends the shake at rest, then squashes', () => {
    expect(buildPose(0)).toEqual(REST_POSE)
    expect(buildPose(SHAKE_END)).toEqual(REST_POSE)
    const end = buildPose(1)
    expect(end.y).toBeCloseTo(SQUASH_POSE.y)
    expect(end.sx).toBeCloseTo(SQUASH_POSE.sx)
    expect(end.sy).toBeCloseTo(SQUASH_POSE.sy)
  })

  it('hits the design keyframes', () => {
    expect(buildPose(0.09).deg).toBeCloseTo(1.5)
    expect(buildPose(0.38)).toMatchObject({ x: 3, deg: 3.5 })
    const peak = buildPose(0.65)
    expect(peak.deg).toBeCloseTo(-6.5)
    expect(peak.sx).toBeCloseTo(1.03)
  })

  it('keeps the wobble segment gentle and back at rest at its end', () => {
    for (let p = 0; p <= WOBBLE_END; p += 0.01) {
      const pose = buildPose(p)
      expect(Math.abs(pose.deg)).toBeLessThanOrEqual(1.5)
      expect(pose.x).toBe(0)
    }
    expect(buildPose(WOBBLE_END).deg).toBeCloseTo(0)
  })
})

describe('cubicBezier', () => {
  it('matches the end points and a linear curve', () => {
    const linear = cubicBezier(0, 0, 1, 1)
    expect(linear(0)).toBe(0)
    expect(linear(1)).toBe(1)
    expect(linear(0.3)).toBeCloseTo(0.3, 3)
  })

  it('can overshoot, like the enter curve', () => {
    const enter = cubicBezier(0.2, 0.9, 0.3, 1.2)
    const peak = Math.max(
      ...Array.from({ length: 99 }, (_, i) => enter((i + 1) / 100))
    )
    expect(peak).toBeGreaterThan(1)
  })
})

describe('confetti', () => {
  const bits = makeConfetti(CONFETTI_COUNT, seeded(7))

  it('makes 30 bits in the six mode colours, in turn', () => {
    expect(bits).toHaveLength(30)
    bits.forEach((b, i) => expect(b.color).toBe(CONFETTI_COLORS[i % 6]))
  })

  it('fans every bit up out of the plate, then lets it fall below its peak', () => {
    for (const b of bits) {
      expect(b.y).toBeLessThan(-40)
      expect(b.y2).toBeGreaterThan(b.y + 200)
    }
  })

  it('times the burst by its slowest bit, within the design range', () => {
    const total = confettiMs(bits)
    expect(total).toBe(Math.max(...bits.map((b) => b.delay + b.t)))
    expect(total).toBeGreaterThanOrEqual(1200)
    expect(total).toBeLessThanOrEqual(1780)
  })

  it('flies each bit from the centre to its peak and out to its end, fading', () => {
    const b = bits[0]
    const start = bitPose(b, 0)
    expect(start.x).toBeCloseTo(0)
    expect(start.y).toBeCloseTo(0)
    expect(start.scale).toBeCloseTo(0.3)
    expect(start.opacity).toBe(1)
    const peak = bitPose(b, b.delay + b.t * 0.45)
    expect(peak.x).toBeCloseTo(b.x)
    expect(peak.y).toBeCloseTo(b.y)
    expect(peak.scale).toBeCloseTo(1)
    const end = bitPose(b, b.delay + b.t)
    expect(end).toMatchObject({ x: b.x2, y: b.y2, opacity: 0 })
    expect(end.scale).toBeCloseTo(0.9)
  })
})

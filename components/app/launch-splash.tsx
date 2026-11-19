'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  afterLeadIn,
  buildPose,
  chooseSplashVariant,
  confettiMs,
  cubicBezier,
  ENTER_MS,
  FLY_OUT_MS,
  JUMP_MS,
  leadInScript,
  makeConfetti,
  popScript,
  REDUCED_FADE_MS,
  revealMs,
  RING_MS,
  SHAKE_END,
  SHAKE_MS,
  SQUASH_MS,
  SQUASH_POSE,
  UNZIP_MS,
  WOBBLE_END,
  WOBBLE_MS,
  WOBBLE_SETTLE_MS,
  type ConfettiBit,
  type SplashVariant,
} from '@/lib/launch/splash-timeline'

const ZIP_H = 16
const PLATE_H = 120
const FLY_OUT_RISE = 760
const UNZIP = cubicBezier(0.65, 0, 0.35, 1)
const FLY_OUT = cubicBezier(0.55, 0, 0.9, 0.4)
const ENTER = cubicBezier(0.2, 0.9, 0.3, 1.2)
const JUMP_UP = cubicBezier(0.2, 0.9, 0.3, 1)
const JUMP_DOWN = cubicBezier(0.3, 0, 0.3, 1)
const JUMP_HOME = cubicBezier(0.25, 0.1, 0.25, 1)
const JUMP_LEGS = [0.3 * JUMP_MS, 0.32 * JUMP_MS, 0.38 * JUMP_MS] as const
const linear = (x: number) => x
const INTRO_SEEN_KEY = 'plate-curator-launch-intro-seen'

type Phase = 'lead-in' | 'wobble' | 'pop' | 'reveal' | 'done'
type Ease = (x: number) => number
interface Tween {
  from: number
  to: number
  start: number
  ms: number
  ease: Ease
}

/** A value held still until a tween replaces it. */
function hold(value: number): Tween {
  return { from: value, to: value, start: 0, ms: 0, ease: linear }
}

/** A tween's value at `now`. */
function tweenAt(t: Tween, now: number): number {
  if (t.ms <= 0) return t.to
  const p = Math.min(1, Math.max(0, (now - t.start) / t.ms))
  return t.from + (t.to - t.from) * t.ease(p)
}

/** One axis of the jump's bounce: squash → 1.16 → .97 → 1. */
function jumpScale(from: number, ms: number): number {
  const [up, down, home] = JUMP_LEGS
  if (ms < up) return from + (1.16 - from) * JUMP_UP(ms / up)
  if (ms < up + down) return 1.16 + (0.97 - 1.16) * JUMP_DOWN((ms - up) / down)
  return 0.97 + 0.03 * JUMP_HOME(Math.min(1, (ms - up - down) / home))
}

/** The zigzag edge that rides up with the cover as it unzips. */
function zigzagPath(width: number): string {
  let d = ''
  for (let x = 0; x <= width + ZIP_H; x += ZIP_H)
    d += `M${x - ZIP_H / 2} 0L${x} ${ZIP_H / 2}L${x + ZIP_H / 2} 0Z`
  return d
}

/** Read whether this browser has already seen the full intro. */
function introSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Remember that the intro has played so later loads skip the shake. */
function markIntroSeen() {
  try {
    localStorage.setItem(INTRO_SEEN_KEY, '1')
  } catch {}
}

/** Whether the viewer asked the system for reduced motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Fly each confetti bit up out of the plate and let it fall, fading out. */
function Burst({ bits }: { bits: readonly ConfettiBit[] }) {
  const refs = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    const animations = bits.map((bit, i) =>
      refs.current[i]?.animate?.(
        [
          {
            transform: 'translate(0px, 0px) rotate(0deg) scale(0.3)',
            opacity: 1,
            easing: 'cubic-bezier(0.1, 0.75, 0.3, 1)',
          },
          {
            offset: 0.45,
            transform: `translate(${bit.x}px, ${bit.y}px) rotate(${bit.r}deg) scale(1)`,
            opacity: 1,
            easing: 'cubic-bezier(0.4, 0, 0.8, 0.6)',
          },
          {
            transform: `translate(${bit.x2}px, ${bit.y2}px) rotate(${bit.r2}deg) scale(0.9)`,
            opacity: 0,
          },
        ],
        { duration: bit.t, delay: bit.delay, fill: 'both' }
      )
    )
    return () => animations.forEach((a) => a?.cancel())
  }, [bits])
  return (
    <>
      <span className="launch-splash-ring" />
      {bits.map((bit, i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          className="launch-splash-bit"
          style={{
            width: bit.w,
            height: bit.h,
            borderRadius: bit.radius,
            background: bit.color,
          }}
        />
      ))}
    </>
  )
}

/** The green check badge that pops onto the plate's corner when it is spotted. */
function CheckBadge({ entry }: { entry: 'pop' | 'fade' }) {
  return (
    <span className={`launch-splash-check launch-splash-check-${entry}`}>
      <span className="launch-splash-check-disc">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M5 12.5l4.5 4.5L19 7.5"
            stroke="currentColor"
            strokeWidth={3.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={30}
          />
        </svg>
      </span>
    </span>
  )
}

export interface LaunchSplashProps {
  ready: boolean
  variant?: SplashVariant
  onDone?: () => void
}

/**
 * The State Spotter "Spotted" splash over the dashboard's first load: the blank plate
 * wobbles while the app loads, then squashes, jumps and gets spotted (check, ring,
 * confetti) before the dark cover unzips upward and the plate flies off. Timings and
 * keyframes live in lib/launch/splash-timeline.ts.
 */
export function LaunchSplash({
  ready,
  variant: forced,
  onDone,
}: LaunchSplashProps) {
  const [variant, setVariant] = useState<SplashVariant | null>(forced ?? null)
  const [phase, setPhaseState] = useState<Phase>('lead-in')
  const [check, setCheck] = useState<'pop' | 'fade' | null>(null)
  const [bits, setBits] = useState<ConfettiBit[] | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const phaseRef = useRef<Phase>('lead-in')
  const readyRef = useRef(ready)
  const onDoneRef = useRef(onDone)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const zipRef = useRef<SVGSVGElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const plateRef = useRef<HTMLDivElement>(null)
  const anim = useRef({
    entered: hold(0),
    mode: 'build' as 'build' | 'jump',
    build: hold(0),
    wobbleStart: null as number | null,
    jumpStart: 0,
    lifted: hold(0),
    flown: hold(0),
  })

  useLayoutEffect(() => {
    readyRef.current = ready
    onDoneRef.current = onDone
  })

  const setPhase = (next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }
  const at = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms))
  }
  const tween = (
    from: number,
    to: number,
    ms: number,
    ease: Ease = linear
  ): Tween => ({
    from,
    to,
    start: performance.now(),
    ms,
    ease,
  })

  const reveal = (v: SplashVariant) => {
    if (phaseRef.current === 'reveal' || phaseRef.current === 'done') return
    setPhase('reveal')
    const a = anim.current
    if (v === 'reduced') a.lifted = tween(0, 1, REDUCED_FADE_MS)
    else {
      a.lifted = tween(0, 1, UNZIP_MS, UNZIP)
      a.flown = tween(0, 1, FLY_OUT_MS, FLY_OUT)
    }
    at(revealMs(v), () => {
      setPhase('done')
      onDoneRef.current?.()
    })
  }

  const pop = (v: SplashVariant) => {
    setPhase('pop')
    const a = anim.current
    for (const { atMs, step } of popScript(v)) {
      at(atMs, () => {
        if (step === 'squash') {
          a.mode = 'build'
          a.wobbleStart = null
          a.build = tween(SHAKE_END, 1, SQUASH_MS)
        } else if (step === 'jump') {
          a.mode = 'jump'
          a.jumpStart = performance.now()
        } else if (step === 'spotted') {
          setCheck('pop')
          setBits(makeConfetti())
          markIntroSeen()
        } else if (step === 'check') {
          setCheck('fade')
          markIntroSeen()
        } else reveal(v)
      })
    }
  }

  const wobble = (v: SplashVariant) => {
    setPhase('wobble')
    if (v === 'reduced') return
    anim.current.mode = 'build'
    anim.current.wobbleStart = performance.now()
  }

  useEffect(() => {
    const pending = timers.current
    const v =
      forced ??
      chooseSplashVariant({
        introSeen: introSeen(),
        reduceMotion: prefersReducedMotion(),
      })
    at(0, () => {
      setVariant(v)
      setSize({ width: window.innerWidth, height: window.innerHeight })
    })
    const a = anim.current
    for (const { atMs, step } of leadInScript(v)) {
      at(atMs, () => {
        if (step === 'enter') a.entered = tween(0, 1, ENTER_MS, ENTER)
        else if (step === 'shake') a.build = tween(0, SHAKE_END, SHAKE_MS)
        else if (afterLeadIn(readyRef.current) === 'pop') pop(v)
        else wobble(v)
      })
    }
    if (v === 'reduced') a.entered = hold(1)
    return () => pending.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready || phase !== 'wobble' || !variant) return
    if (variant === 'reduced') {
      at(0, () => pop(variant))
      return
    }
    const a = anim.current
    const now = performance.now()
    const current =
      (((now - (a.wobbleStart ?? now)) % WOBBLE_MS) / WOBBLE_MS) * WOBBLE_END
    a.wobbleStart = null
    a.build = tween(current, 0, WOBBLE_SETTLE_MS)
    at(WOBBLE_SETTLE_MS, () => pop(variant))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, phase])

  useEffect(() => {
    if (phase === 'done') return
    let frame = 0
    const draw = () => {
      const now = performance.now()
      const a = anim.current
      const height = window.innerHeight
      const e = tweenAt(a.entered, now)
      const grow = 0.9 + 0.1 * e
      let pose
      if (a.mode === 'jump') {
        const ms = now - a.jumpStart
        pose = {
          x: 0,
          y: SQUASH_POSE.y * (1 - JUMP_UP(Math.min(1, ms / JUMP_LEGS[0]))),
          deg: 0,
          sx: jumpScale(SQUASH_POSE.sx, ms),
          sy: jumpScale(SQUASH_POSE.sy, ms),
        }
      } else {
        const b =
          a.wobbleStart !== null
            ? (((now - a.wobbleStart) % WOBBLE_MS) / WOBBLE_MS) * WOBBLE_END
            : tweenAt(a.build, now)
        pose = buildPose(b)
      }
      if (plateRef.current) {
        plateRef.current.style.opacity = String(Math.min(1, Math.max(0, e)))
        plateRef.current.style.transform = `translate(${pose.x}px, ${pose.y}px) rotate(${pose.deg}deg) scale(${pose.sx * grow}, ${pose.sy * grow})`
      }
      const lifted = tweenAt(a.lifted, now)
      const flown = tweenAt(a.flown, now)
      if (variant === 'reduced') {
        if (rootRef.current) rootRef.current.style.opacity = String(1 - lifted)
      } else {
        if (coverRef.current)
          coverRef.current.style.height = `${height * (1 - lifted)}px`
        if (zipRef.current)
          zipRef.current.style.transform = `translateY(${height - lifted * (height + ZIP_H)}px)`
      }
      const rise = Math.max(FLY_OUT_RISE, height / 2 + PLATE_H * 2)
      if (stageRef.current)
        stageRef.current.style.transform = `translateY(${-rise * flown}px) rotate(${4 * flown}deg)`
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [phase, variant])

  useEffect(() => {
    if (!bits) return
    const end = setTimeout(
      () => setBits(null),
      Math.max(confettiMs(bits), RING_MS)
    )
    return () => clearTimeout(end)
  }, [bits])

  if (phase === 'done') return null

  return (
    <div
      ref={rootRef}
      className="launch-splash"
      data-phase={phase}
      role="img"
      aria-label="A license plate gets spotted"
    >
      <div ref={coverRef} className="launch-splash-cover" />
      {phase === 'reveal' && variant !== 'reduced' && size.width ? (
        <svg
          ref={zipRef}
          className="launch-splash-zip"
          width={size.width}
          height={ZIP_H}
          aria-hidden
        >
          <path d={zigzagPath(size.width)} />
        </svg>
      ) : null}
      <div ref={stageRef} className="launch-splash-stage">
        {bits && variant !== 'reduced' ? <Burst bits={bits} /> : null}
        <div ref={plateRef} className="launch-splash-plate">
          <div className="launch-splash-face">
            <span className="launch-splash-inset" />
            <span
              className="launch-splash-bolt"
              style={{ left: 30, top: 16 }}
            />
            <span
              className="launch-splash-bolt"
              style={{ right: 30, top: 16 }}
            />
            <span
              className="launch-splash-bolt"
              style={{ left: 30, bottom: 16 }}
            />
            <span
              className="launch-splash-bolt"
              style={{ right: 30, bottom: 16 }}
            />
            {check ? <CheckBadge entry={check} /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

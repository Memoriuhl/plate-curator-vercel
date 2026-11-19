import { topicSignalId, type ChangeTopic } from '../live/topics'

export type LiveStatus = 'connecting' | 'live' | 'unavailable'

export type LiveGrant = { envKey: string; expiresAt: string }

/** A revision listener on one signal document, such as a Firestore `onSnapshot`. */
export type LiveSignalSource = {
  subscribe(
    envKey: string,
    signalId: string,
    next: (revision: number | null) => void,
    error: (error: { code?: string }) => void
  ): () => void
}

export type LiveHubOptions = {
  source: LiveSignalSource
  now?: () => number
  /** Smallest gap between two refresh rounds in the tab. */
  throttleMs?: number
  /** Polling interval used only while a topic's listener has failed. */
  fallbackMs?: number
  /** Report whether the page is visible, and announce visibility changes. */
  visible?: () => boolean
  watchVisibility?: (changed: () => void) => () => void
}

/** The parts of a subscription a view can change without subscribing again. */
export type LiveSettings = {
  /** The request the refresh makes. Views with the same key share one refresh per round. */
  key?: string
  /** Optional slow refresh while visible, for state that changes without a write. */
  safetyMs?: number
}

export type LiveSubscription = LiveSettings & {
  topics: readonly ChangeTopic[]
  refresh: () => unknown
  onStatus?: (status: LiveStatus) => void
}

/** Stop the subscription by calling it; `update` changes its key or safety interval. */
export type LiveHandle = (() => void) & {
  update(settings: LiveSettings): void
}

type Subscriber = LiveSubscription & {
  /** Earliest refresh: one throttle window after the view's own first fetch. */
  notBefore: number
  /** A refresh is owed, kept while hidden so the tab catches up once when shown. */
  dirty: boolean
  /** The one polling schedule for this view: its safety interval, or the fallback. */
  poll: ReturnType<typeof setInterval> | null
  pollMs: number | null
  status: LiveStatus | null
}

type Topic = {
  subscribers: Set<Subscriber>
  stop: (() => void) | null
  /** Last revision seen, kept across reconnects so a resumed listener can catch up. */
  seen: number | null
  status: LiveStatus
  retried: boolean
  /** Bumped on every connect so a slow grant cannot attach an outdated listener. */
  attempt: number
}

/** Renew a grant this long before it expires. */
const renewEarlyMs = 60_000

const defaultVisible = () =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden'

const defaultWatchVisibility = (changed: () => void) => {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

/**
 * Share one listener per change topic across every view in the tab. Signals mark views
 * as owing a refresh, and the tab runs owed refreshes in rounds at most once per throttle
 * window, one request per key. Hidden tabs stop listening, polling and renewing, keep
 * what they owe, and catch up once when shown. A failed listener moves each of its views
 * to one slow polling schedule and reports 'unavailable' so the view can say so.
 */
export function createLiveHub(options: LiveHubOptions) {
  const now = options.now ?? (() => Date.now())
  const throttleMs = options.throttleMs ?? 2000
  const fallbackMs = options.fallbackMs ?? 30_000
  const visible = options.visible ?? defaultVisible
  const watchVisibility = options.watchVisibility ?? defaultWatchVisibility
  const topics = new Map<ChangeTopic, Topic>()
  const subscribers = new Set<Subscriber>()
  let lastRound = -Infinity
  let round: ReturnType<typeof setTimeout> | null = null
  let roundAt = Infinity
  let requestGrant: (() => Promise<LiveGrant>) | null = null
  let grant: Promise<LiveGrant> | null = null
  let grantExpires: number | null = null
  let renewal: ReturnType<typeof setTimeout> | null = null
  let unwatch: (() => void) | null = null

  /** Run the next round as soon as the tab's throttle window and the views allow. */
  function schedule() {
    if (!visible()) return
    let earliest = Infinity
    for (const subscriber of subscribers)
      if (subscriber.dirty) earliest = Math.min(earliest, subscriber.notBefore)
    if (earliest === Infinity) return
    // A round due now still waits for the current task, so signals and polls that
    // arrive together share it.
    const due = Math.max(lastRound + throttleMs, earliest, now())
    if (round && roundAt <= due) return
    cancelRound()
    roundAt = due
    round = setTimeout(runRound, due - now())
  }

  function cancelRound() {
    if (round) clearTimeout(round)
    round = null
    roundAt = Infinity
  }

  /** Refresh every view that owes one and is ready, once per request key. */
  function runRound() {
    round = null
    roundAt = Infinity
    const at = now()
    const ready = [...subscribers].filter(
      (subscriber) => subscriber.dirty && subscriber.notBefore <= at
    )
    if (ready.length) lastRound = at
    const keys = new Set<string>()
    for (const subscriber of ready) {
      if (!subscriber.dirty) continue
      subscriber.dirty = false
      if (subscriber.key !== undefined) {
        // This request also serves every other view of the same key.
        for (const other of subscribers)
          if (other.key === subscriber.key) other.dirty = false
        if (keys.has(subscriber.key)) continue
        keys.add(subscriber.key)
      }
      void Promise.resolve()
        .then(subscriber.refresh)
        .catch(() => undefined)
    }
    schedule()
  }

  function owe(subscriber: Subscriber) {
    subscriber.dirty = true
    schedule()
  }

  function refreshAll(topic: Topic) {
    for (const subscriber of topic.subscribers) subscriber.dirty = true
    schedule()
  }

  function statusOf(subscriber: Subscriber): LiveStatus {
    const states = subscriber.topics.map((name) => topics.get(name)?.status)
    if (states.includes('unavailable')) return 'unavailable'
    if (states.includes('connecting')) return 'connecting'
    return 'live'
  }

  /**
   * Keep one polling schedule per view: the fallback interval while a topic is down, or
   * its own safety interval if that is shorter or the topics are live. Off while hidden.
   */
  function setPoll(subscriber: Subscriber) {
    const fallback = statusOf(subscriber) === 'unavailable' ? fallbackMs : null
    const safety = subscriber.safetyMs || null
    const ms = !visible()
      ? null
      : fallback && safety
        ? Math.min(fallback, safety)
        : (fallback ?? safety)
    if (ms === subscriber.pollMs) return
    if (subscriber.poll) clearInterval(subscriber.poll)
    subscriber.pollMs = ms
    subscriber.poll = ms ? setInterval(() => owe(subscriber), ms) : null
  }

  function announce(topic: Topic) {
    for (const subscriber of topic.subscribers) {
      setPoll(subscriber)
      const status = statusOf(subscriber)
      if (status === subscriber.status) continue
      subscriber.status = status
      subscriber.onStatus?.(status)
    }
  }

  function scheduleRenewal() {
    if (renewal) clearTimeout(renewal)
    renewal = null
    if (grantExpires === null || !visible()) return
    renewal = setTimeout(
      () => {
        renewal = null
        void currentGrant(true).then(
          () => {
            for (const [name, topic] of topics)
              if (topic.stop) listen(name, topic)
          },
          () => undefined
        )
      },
      Math.max(1000, grantExpires - now() - renewEarlyMs)
    )
  }

  /** Fetch a live grant once and renew it shortly before it expires. */
  function currentGrant(force = false): Promise<LiveGrant> {
    if (!requestGrant) return Promise.reject(new Error('No live grant'))
    if (grant && !force) return grant
    const pending = requestGrant()
    grant = pending
    pending.then(
      (value) => {
        if (grant !== pending) return
        const expires = Date.parse(value?.expiresAt ?? '')
        if (typeof value?.envKey !== 'string' || !Number.isFinite(expires)) {
          // A malformed grant: forget it so the next listen asks again.
          grant = null
          grantExpires = null
          scheduleRenewal()
          return
        }
        grantExpires = expires
        scheduleRenewal()
      },
      () => {
        if (grant === pending) grant = null
      }
    )
    return pending
  }

  function startFallback(topic: Topic) {
    topic.status = 'unavailable'
    announce(topic)
    // Anything owed from before a resume runs now rather than at the first poll.
    schedule()
  }

  function detach(topic: Topic) {
    topic.stop?.()
    topic.stop = null
  }

  /** Detach the topic and cancel any connect still waiting for a grant. */
  function stopListening(topic: Topic) {
    topic.attempt++
    detach(topic)
  }

  /** (Re)attach the topic's listener with the current grant. */
  function listen(name: ChangeTopic, topic: Topic, force = false) {
    const attempt = ++topic.attempt
    void currentGrant(force)
      .then((value) => {
        if (topics.get(name) !== topic || attempt !== topic.attempt) return
        if (!visible()) return
        detach(topic)
        let stopped = false
        let unsubscribe: (() => void) | null = null
        const stop = () => {
          stopped = true
          unsubscribe?.()
        }
        if (typeof value?.envKey !== 'string') throw new Error('Bad grant')
        unsubscribe = options.source.subscribe(
          value.envKey,
          topicSignalId(name),
          (revision) => {
            if (stopped) return
            const current = revision ?? 0
            const previous = topic.seen
            topic.seen = current
            topic.retried = false
            if (topic.status !== 'live') {
              topic.status = 'live'
              announce(topic)
            }
            // The first snapshot also refreshes once (after the throttle window), since a
            // change can land between a view's first fetch and the listener attaching.
            // Otherwise run anything owed from before the tab was hidden.
            if (previous === null || current > previous) refreshAll(topic)
            else schedule()
          },
          (error) => {
            if (stopped) return
            stop()
            if (topic.stop === stop) topic.stop = null
            if (error.code === 'permission-denied' && !topic.retried) {
              // An expired grant: renew it once and listen again.
              topic.retried = true
              topic.status = 'connecting'
              announce(topic)
              listen(name, topic, true)
            } else startFallback(topic)
          }
        )
        if (stopped) unsubscribe()
        else topic.stop = stop
      })
      .catch(() => {
        // No grant, or the listener could not start: poll slowly instead.
        if (topics.get(name) === topic && attempt === topic.attempt)
          startFallback(topic)
      })
  }

  function onVisibility() {
    if (!visible()) {
      // Owed refreshes stay marked; the round, polls and renewal wait for the tab.
      cancelRound()
      if (renewal) clearTimeout(renewal)
      renewal = null
      for (const topic of topics.values()) stopListening(topic)
      for (const subscriber of subscribers) setPoll(subscriber)
      return
    }
    // A grant that expires within the renewal margin is replaced before listening.
    if (grantExpires !== null && grantExpires - now() <= renewEarlyMs) {
      grant = null
      grantExpires = null
    } else scheduleRenewal()
    for (const [name, topic] of topics) {
      // Resumed: retry a failed listener, and let the first snapshot decide on catch-up.
      if (topic.status === 'unavailable') {
        topic.retried = false
        for (const subscriber of topic.subscribers) subscriber.dirty = true
      }
      listen(name, topic)
    }
    for (const subscriber of subscribers) setPoll(subscriber)
  }

  function teardown() {
    for (const topic of topics.values()) stopListening(topic)
    topics.clear()
    unwatch?.()
    unwatch = null
    cancelRound()
    if (renewal) clearTimeout(renewal)
    renewal = null
    grant = null
    grantExpires = null
  }

  return {
    /** Set how to obtain a live grant; the latest session's sender wins. */
    setGrant(next: () => Promise<LiveGrant>) {
      requestGrant = next
    },
    subscribe(subscription: LiveSubscription): LiveHandle {
      const subscriber: Subscriber = {
        ...subscription,
        topics: [...new Set(subscription.topics)],
        // Treat subscribing as a fresh fetch: callers subscribe right after loading.
        notBefore: now() + throttleMs,
        dirty: false,
        poll: null,
        pollMs: null,
        status: null,
      }
      subscribers.add(subscriber)
      unwatch ??= watchVisibility(onVisibility)
      let late = false
      for (const name of subscriber.topics) {
        let topic = topics.get(name)
        if (!topic) {
          topic = {
            subscribers: new Set(),
            stop: null,
            seen: null,
            status: 'connecting',
            retried: false,
            attempt: 0,
          }
          topics.set(name, topic)
          topic.subscribers.add(subscriber)
          if (visible()) listen(name, topic)
        } else {
          topic.subscribers.add(subscriber)
          // The shared listener may have consumed a change this view's fetch missed.
          if (topic.seen !== null && topic.status === 'live') late = true
        }
      }
      subscriber.status = statusOf(subscriber)
      subscriber.onStatus?.(subscriber.status)
      setPoll(subscriber)
      if (late) owe(subscriber)
      const stop = () => {
        subscribers.delete(subscriber)
        if (subscriber.poll) clearInterval(subscriber.poll)
        subscriber.poll = null
        for (const name of subscriber.topics) {
          const topic = topics.get(name)
          if (!topic) continue
          topic.subscribers.delete(subscriber)
          if (topic.subscribers.size === 0) {
            stopListening(topic)
            topics.delete(name)
          }
        }
        if (topics.size === 0) teardown()
      }
      return Object.assign(stop, {
        update(settings: LiveSettings) {
          if (!subscribers.has(subscriber)) return
          subscriber.key = settings.key
          subscriber.safetyMs = settings.safetyMs
          setPoll(subscriber)
        },
      })
    },
  }
}

export type LiveHub = ReturnType<typeof createLiveHub>

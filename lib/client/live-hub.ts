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
  /** Smallest gap between two refreshes of the same subscriber. */
  throttleMs?: number
  /** Refresh interval used only after a topic's listener fails. */
  fallbackMs?: number
  /** Report whether the page is visible, and announce visibility changes. */
  visible?: () => boolean
  watchVisibility?: (changed: () => void) => () => void
}

export type LiveSubscription = {
  topics: readonly ChangeTopic[]
  refresh: () => unknown
  /** Optional slow refresh while visible, for state that changes without a write. */
  safetyMs?: number
  onStatus?: (status: LiveStatus) => void
}

type Subscriber = LiveSubscription & {
  last: number
  timer: ReturnType<typeof setTimeout> | null
  safety: ReturnType<typeof setInterval> | null
  status: LiveStatus | null
}

type Topic = {
  subscribers: Set<Subscriber>
  stop: (() => void) | null
  /** Last revision seen, kept across reconnects so a resumed listener can catch up. */
  seen: number | null
  status: LiveStatus
  retried: boolean
  fallback: ReturnType<typeof setInterval> | null
  /** Bumped on every connect so a slow grant cannot attach an outdated listener. */
  attempt: number
}

const defaultVisible = () =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden'

const defaultWatchVisibility = (changed: () => void) => {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

/**
 * Share one listener per change topic across every subscriber in the tab. A signal makes
 * each subscriber refresh at most once per throttle window. Hidden tabs stop listening
 * and compare revisions when they become visible again, so they refresh only if something
 * changed. A failed listener falls back to one slow refresh loop for that topic, and
 * reports 'unavailable' so the view can say so.
 */
export function createLiveHub(options: LiveHubOptions) {
  const now = options.now ?? (() => Date.now())
  const throttleMs = options.throttleMs ?? 2000
  const fallbackMs = options.fallbackMs ?? 30_000
  const visible = options.visible ?? defaultVisible
  const watchVisibility = options.watchVisibility ?? defaultWatchVisibility
  const topics = new Map<ChangeTopic, Topic>()
  let requestGrant: (() => Promise<LiveGrant>) | null = null
  let grant: Promise<LiveGrant> | null = null
  let renewal: ReturnType<typeof setTimeout> | null = null
  let unwatch: (() => void) | null = null

  /** Refresh now, or once at the end of the throttle window if one just ran. */
  function request(subscriber: Subscriber) {
    if (subscriber.timer) return
    const wait = subscriber.last + throttleMs - now()
    const run = () => {
      subscriber.timer = null
      subscriber.last = now()
      void Promise.resolve()
        .then(subscriber.refresh)
        .catch(() => undefined)
    }
    if (wait <= 0) run()
    else subscriber.timer = setTimeout(run, wait)
  }

  function statusOf(subscriber: Subscriber): LiveStatus {
    const states = subscriber.topics.map((name) => topics.get(name)?.status)
    if (states.includes('unavailable')) return 'unavailable'
    if (states.includes('connecting')) return 'connecting'
    return 'live'
  }

  function announce(topic: Topic) {
    for (const subscriber of topic.subscribers) {
      const status = statusOf(subscriber)
      if (status === subscriber.status) continue
      subscriber.status = status
      subscriber.onStatus?.(status)
    }
  }

  function refreshAll(topic: Topic) {
    for (const subscriber of topic.subscribers) request(subscriber)
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
        if (renewal) clearTimeout(renewal)
        renewal = null
        const expires = Date.parse(value?.expiresAt ?? '')
        if (typeof value?.envKey !== 'string' || !Number.isFinite(expires)) {
          // A malformed grant: forget it so the next listen asks again.
          grant = null
          return
        }
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
          Math.max(1000, expires - now() - 60_000)
        )
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
    if (!topic.fallback && visible())
      topic.fallback = setInterval(() => refreshAll(topic), fallbackMs)
  }

  function detach(topic: Topic) {
    topic.stop?.()
    topic.stop = null
    if (topic.fallback) clearInterval(topic.fallback)
    topic.fallback = null
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
            if (previous === null || current > previous) refreshAll(topic)
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
        // No grant, or the listener could not start: refresh slowly instead.
        if (topics.get(name) === topic && attempt === topic.attempt)
          startFallback(topic)
      })
  }

  function onVisibility() {
    const shown = visible()
    for (const [name, topic] of topics) {
      if (!shown) {
        stopListening(topic)
        continue
      }
      // Resumed: retry a failed listener, and let the first snapshot decide on catch-up.
      if (topic.status === 'unavailable') {
        topic.retried = false
        refreshAll(topic)
      }
      listen(name, topic)
    }
    for (const topic of topics.values())
      for (const subscriber of topic.subscribers) setSafety(subscriber, shown)
  }

  function setSafety(subscriber: Subscriber, on: boolean) {
    if (subscriber.safety) clearInterval(subscriber.safety)
    subscriber.safety =
      on && subscriber.safetyMs
        ? setInterval(() => request(subscriber), subscriber.safetyMs)
        : null
  }

  function teardown() {
    for (const topic of topics.values()) stopListening(topic)
    topics.clear()
    unwatch?.()
    unwatch = null
    if (renewal) clearTimeout(renewal)
    renewal = null
    grant = null
  }

  return {
    /** Set how to obtain a live grant; the latest session's sender wins. */
    setGrant(next: () => Promise<LiveGrant>) {
      requestGrant = next
    },
    subscribe(subscription: LiveSubscription): () => void {
      const subscriber: Subscriber = {
        ...subscription,
        topics: [...new Set(subscription.topics)],
        // Treat subscribing as a fresh fetch: callers subscribe right after loading.
        last: now(),
        timer: null,
        safety: null,
        status: null,
      }
      unwatch ??= watchVisibility(onVisibility)
      for (const name of subscriber.topics) {
        let topic = topics.get(name)
        if (!topic) {
          topic = {
            subscribers: new Set(),
            stop: null,
            seen: null,
            status: 'connecting',
            retried: false,
            fallback: null,
            attempt: 0,
          }
          topics.set(name, topic)
          topic.subscribers.add(subscriber)
          if (visible()) listen(name, topic)
        } else topic.subscribers.add(subscriber)
      }
      subscriber.status = statusOf(subscriber)
      subscriber.onStatus?.(subscriber.status)
      setSafety(subscriber, visible())
      return () => {
        if (subscriber.timer) clearTimeout(subscriber.timer)
        setSafety(subscriber, false)
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
    },
  }
}

export type LiveHub = ReturnType<typeof createLiveHub>

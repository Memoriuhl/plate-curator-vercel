'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  createLiveHub,
  type LiveGrant,
  type LiveHandle,
  type LiveHub,
  type LiveSignalSource,
  type LiveStatus,
} from './live-hub'
import { draftTopic, type ChangeTopic } from '../live/topics'
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  onSnapshot,
} from 'firebase/firestore'
import { useSWRConfig } from 'swr'
import { batchApiPath, dashboardDraftPath, isDashboardDraftKey } from './api'
import { clientApp, emulatorConnected, emulatorHost } from './firebase'
import { countClientUsage } from './usage'
import { useSession } from './session'
import { signalPath } from '../review/signals/live-signal'

export type { LiveSignalSource, LiveStatus } from './live-hub'
/** Resolve the browser Firestore instance, using the local emulator for demo projects. */
function clientFirestore() {
  const db = getFirestore(clientApp())
  const host = emulatorHost(process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST)
  if (host && !emulatorConnected.has(db)) {
    const split = host.lastIndexOf(':')
    connectFirestoreEmulator(
      db,
      host.slice(0, split),
      Number(host.slice(split + 1))
    )
    emulatorConnected.add(db)
  }
  return db
}

const source: LiveSignalSource = {
  /**
   * Subscribe to the batch's Firestore revision signal and normalize its value for the
   * client.
   */
  subscribe(envKey, batchId, next, error) {
    const usageKey = batchId.startsWith('topic:') ? batchId : 'batch'
    countClientUsage('listen', usageKey)
    return onSnapshot(
      doc(clientFirestore(), signalPath(envKey, batchId)),
      (snapshot) => {
        countClientUsage('snapshot', usageKey)
        const revision = snapshot.data()?.revision
        next(
          typeof revision === 'number' &&
            Number.isInteger(revision) &&
            revision >= 0
            ? revision
            : null
        )
      },
      error
    )
  },
}
const LiveSource = createContext<LiveSignalSource>(source)
export const LiveSignalProvider = LiveSource.Provider

// One hub per signal source, so every hook in the tab shares listeners and the grant.
const hubs = new WeakMap<LiveSignalSource, LiveHub>()

/**
 * Refetch with `refresh` when the server signals a change to any of `topics`, instead of
 * polling. The tab refreshes at most once per two seconds, once per request `key`, stops
 * while hidden, and falls back to one slow poll per view if the listener fails.
 * `safetyMs` adds a slow refresh while visible, for state that can change without a
 * write, such as a worker going quiet. Changing `key` or `safetyMs` keeps the listener.
 */
export function useLiveRefresh(
  topics: readonly ChangeTopic[],
  refresh: () => unknown,
  options: {
    enabled?: boolean
    safetyMs?: number
    key?: string
    refreshOnResume?: boolean
  } = {}
): LiveStatus {
  const selectedSource = useContext(LiveSource)
  const session = useSession(false)
  const api = session?.api
  const uid = session?.user?.uid ?? null
  const latest = useRef({ refresh, api })
  useEffect(() => {
    latest.current = { refresh, api }
  })
  const enabled = (options.enabled ?? true) && uid !== null && api !== undefined
  const topicKey = topics.join(' ')
  const { safetyMs, key, refreshOnResume } = options
  const settings = useRef({ safetyMs, key })
  const handle = useRef<LiveHandle | null>(null)
  const [status, setStatus] = useState<LiveStatus>('connecting')
  useEffect(() => {
    if (!enabled) return
    let hub = hubs.get(selectedSource)
    if (!hub) {
      hub = createLiveHub({ source: selectedSource })
      hubs.set(selectedSource, hub)
    }
    hub.setGrant(async () => {
      const sender = latest.current.api
      if (!sender) throw new Error('Signed out')
      return sender.send<LiveGrant>('POST', '/api/live-access', {})
    })
    const subscription = hub.subscribe({
      topics: topicKey.split(' ') as ChangeTopic[],
      refresh: () => latest.current.refresh(),
      refreshOnResume,
      ...settings.current,
      onStatus: setStatus,
    })
    handle.current = subscription
    return () => {
      handle.current = null
      subscription()
    }
  }, [enabled, uid, topicKey, selectedSource, refreshOnResume])
  useEffect(() => {
    settings.current = { safetyMs, key }
    handle.current?.update({ safetyMs, key })
  }, [safetyMs, key])
  return enabled ? status : 'connecting'
}

/** Share one state refresh round between the grid and the linked draft bar. */
export function useDashboardDraftSignal(
  code: string | null,
  refresh: () => unknown
) {
  return useLiveRefresh(code ? [draftTopic(code)] : [], refresh, {
    enabled: code !== null,
    key: code ? dashboardDraftPath(code) : undefined,
    refreshOnResume: true,
    safetyMs: 600_000,
  })
}

/**
 * Watch for newer batch revisions and refresh SWR detail while managing the live access
 * grant.
 */
export function useBatchRevisionSignal(
  batchId: string | null,
  displayedRevision: number
) {
  const selectedSource = useContext(LiveSource)
  const { user, api } = useSession()
  const { mutate } = useSWRConfig()
  const displayed = useRef(displayedRevision)
  useEffect(() => {
    displayed.current = displayedRevision
  }, [displayedRevision])
  const [status, setStatus] = useState<{ id: string | null; text: string }>({
    id: batchId,
    text: 'Updating',
  })
  useEffect(() => {
    if (batchId === null || !user) return
    const batchKey = batchApiPath(batchId)
    let disposed = false
    let stopped = false
    /** Provide a safe cleanup action before the first live listener has been attached. */
    let unsubscribe = () => {}
    let renewal: ReturnType<typeof setTimeout>
    let queued: ReturnType<typeof setTimeout>
    let seen = -1
    let retried = false
    let refreshing = false
    /**
     * Associate the subscription status with this batch so switching batches cannot
     * display stale status.
     */
    const updateStatus = (text: string) => setStatus({ id: batchId, text })
    /** Show the subscription failure only while the hook is still mounted. */
    const unavailable = () => {
      if (!disposed) updateStatus('Live updates unavailable')
    }
    /**
     * Revalidate SWR's batch detail and list entries on a Firestore revision signal.
     * Let an active refresh finish before processing a newer signal.
     */
    const refresh = async () => {
      if (disposed || stopped || refreshing) return
      refreshing = true
      const revision = seen
      try {
        await mutate(
          (key) =>
            typeof key === 'string' &&
            (key === batchKey ||
              key === batchKey + '/publish' ||
              key === batchKey + '/run' ||
              key === '/api/batches' ||
              (key.startsWith('/api/batches?') && !isDashboardDraftKey(key)))
        )
        if (!disposed && !stopped && seen === revision) updateStatus('Live')
      } catch {
        unavailable()
      } finally {
        refreshing = false
        if (!disposed && !stopped && seen > revision)
          queued = setTimeout(() => {
            void refresh()
          }, 25)
      }
    }
    /**
     * Obtain or renew live access and replace the existing revision subscription for the
     * batch.
     */
    const connect = async () => {
      if (disposed || stopped) return
      try {
        const grant = await api.send<{ envKey: string; expiresAt: string }>(
          'POST',
          '/api/live-access',
          {}
        )
        if (disposed || stopped) return
        unsubscribe()
        clearTimeout(renewal)
        renewal = setTimeout(
          () => {
            void connect()
          },
          Math.max(1000, Date.parse(grant.expiresAt) - Date.now() - 60000)
        )
        unsubscribe = selectedSource.subscribe(
          grant.envKey,
          batchId,
          (revision) => {
            if (disposed || stopped) return
            if (revision === null) {
              unavailable()
              return
            }
            if (revision <= seen) return
            if (revision <= displayed.current) {
              seen = revision
              if (!refreshing) updateStatus('Live')
              return
            }
            seen = revision
            updateStatus('Updating')
            clearTimeout(queued)
            queued = setTimeout(() => {
              void refresh()
            }, 25)
          },
          (error) => {
            if (disposed || stopped) return
            clearTimeout(renewal)
            clearTimeout(queued)
            unsubscribe()
            if (error.code === 'permission-denied' && !retried) {
              retried = true
              void connect()
            } else {
              stopped = true
              unavailable()
            }
          }
        )
      } catch {
        unavailable()
      }
    }
    void connect()
    return () => {
      disposed = true
      unsubscribe()
      clearTimeout(renewal)
      clearTimeout(queued)
    }
  }, [batchId, user, api, mutate, selectedSource])
  return status.id === batchId ? status.text : 'Updating'
}

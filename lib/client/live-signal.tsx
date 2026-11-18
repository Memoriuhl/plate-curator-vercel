'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { doc, getFirestore, onSnapshot } from 'firebase/firestore'
import { useSWRConfig } from 'swr'
import { batchApiPath } from './api'
import { clientApp } from './firebase'
import { useSession } from './session'
import { signalPath } from '../review/live-signal'

export type LiveSignalSource = {
  subscribe(envKey: string, batchId: string, next: (revision: number | null) => void, error: (error: { code?: string }) => void): () => void
}
const source: LiveSignalSource = {
  /**
   * Subscribe to the batch's Firestore revision signal and normalize its value for the
   * client.
   */
  subscribe(envKey, batchId, next, error) {
    return onSnapshot(doc(getFirestore(clientApp()), signalPath(envKey, batchId)), snapshot => {
      const revision = snapshot.data()?.revision
      next(typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : null)
    }, error)
  },
}
const LiveSource = createContext<LiveSignalSource>(source)
export const LiveSignalProvider = LiveSource.Provider

/**
 * Watch for newer batch revisions and refresh SWR detail while managing the live access
 * grant.
 */
export function useBatchRevisionSignal(batchId: string | null, displayedRevision: number) {
  const selectedSource = useContext(LiveSource)
  const { user, api } = useSession()
  const { mutate } = useSWRConfig()
  const displayed = useRef(displayedRevision)
  useEffect(() => { displayed.current = displayedRevision }, [displayedRevision])
  const [status, setStatus] = useState<{ id: string | null; text: string }>({ id: batchId, text: 'Updating' })
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
    const unavailable = () => { if (!disposed) updateStatus('Live updates unavailable') }
    /**
     * Refresh batch data in response to a revision signal and retry when a newer
     * revision is still pending.
     */
    const refresh = async () => {
      if (disposed || stopped || refreshing) return
      refreshing = true
      const revision = seen
      try {
        await mutate(key => typeof key === 'string' && (key === batchKey || key === batchKey + '/publish' || key === batchKey + '/run' || key === '/api/batches' || key.startsWith('/api/batches?')))
        if (!disposed && !stopped && seen === revision) updateStatus('Live')
      } catch { unavailable() }
      finally {
        refreshing = false
        if (!disposed && !stopped && seen > revision) queued = setTimeout(() => { void refresh() }, 25)
      }
    }
    /**
     * Obtain or renew live access and replace the existing revision subscription for the
     * batch.
     */
    const connect = async () => {
      if (disposed || stopped) return
      try {
        const grant = await api.send<{ envKey: string; expiresAt: string }>('POST', '/api/live-access', {})
        if (disposed || stopped) return
        unsubscribe()
        clearTimeout(renewal)
        renewal = setTimeout(() => { void connect() }, Math.max(1000, Date.parse(grant.expiresAt) - Date.now() - 60000))
        unsubscribe = selectedSource.subscribe(grant.envKey, batchId, revision => {
          if (disposed || stopped) return
          if (revision === null) { unavailable(); return }
          if (revision <= seen) return
          if (revision <= displayed.current) { seen = revision; if (!refreshing) updateStatus('Live'); return }
          seen = revision
          updateStatus('Updating')
          clearTimeout(queued)
          queued = setTimeout(() => { void refresh() }, 25)
        }, error => {
          if (disposed || stopped) return
          clearTimeout(renewal)
          clearTimeout(queued)
          unsubscribe()
          if (error.code === 'permission-denied' && !retried) { retried = true; void connect() }
          else { stopped = true; unavailable() }
        })
      } catch { unavailable() }
    }
    void connect()
    return () => { disposed = true; unsubscribe(); clearTimeout(renewal); clearTimeout(queued) }
  }, [batchId, user, api, mutate, selectedSource])
  return status.id === batchId ? status.text : 'Updating'
}


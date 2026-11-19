import { subscribe } from 'node:diagnostics_channel'
import { rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { countRequest, startUsageCounts } from './usage-counter'

const started = Symbol.for('plate-curator.usage-recorder')

/**
 * Count every HTTP request the local server receives and write the running totals to a
 * file every two seconds, so a measurement script can diff two snapshots.
 */
export function startUsageRecorder(file: string) {
  const scope = globalThis as Record<symbol, unknown>
  if (scope[started]) return
  scope[started] = true
  const counts = startUsageCounts()
  subscribe('http.server.request.start', (message) => {
    const { request } = message as { request: IncomingMessage }
    countRequest(
      request.method ?? 'GET',
      request.url ?? '/',
      request.headers.rsc === '1'
    )
  })
  let writing = false
  const timer = setInterval(async () => {
    if (writing) return
    writing = true
    try {
      await writeFile(`${file}.tmp`, JSON.stringify(counts))
      await rename(`${file}.tmp`, file)
    } catch (error) {
      console.error('[usage] could not write counts', error)
    } finally {
      writing = false
    }
  }, 2000)
  timer.unref()
  console.log('[usage] counting requests and Firestore operations')
}

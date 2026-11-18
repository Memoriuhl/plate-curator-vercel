import type { Firestore } from '@google-cloud/firestore'

type Device = { path: string; token: string }
type Message = {
  to: string
  title: string
  data: { type: 'catalog'; version: number }
}
export type PushTicket = {
  status: 'ok' | 'error'
  details?: { error?: string }
}
type Counts = { sent: number; failed: number; pruned: number }
export type CatalogPushResult = Counts & {
  status: 'disabled' | 'already_claimed' | 'completed' | 'unavailable'
}
export interface CatalogPushDeps {
  enabled: boolean
  store: {
    claim(version: number): Promise<boolean>
    devices(): Promise<Device[]>
    prune(device: Device): Promise<boolean>
    finish(version: number, result: CatalogPushResult): Promise<void>
  }
  send(messages: Message[]): Promise<PushTicket[]>
}

/**
 * Claim one notification pass per published version, deliver it in batches and prune
 * invalid device registrations.
 */
export async function sendCatalogPush(
  d: CatalogPushDeps,
  version: number
): Promise<CatalogPushResult> {
  const counts: Counts = { sent: 0, failed: 0, pruned: 0 }
  if (!d.enabled) return { status: 'disabled', ...counts }
  let claimed = false
  try {
    if (!(await d.store.claim(version)))
      return { status: 'already_claimed', ...counts }
    claimed = true
    const devices = await d.store.devices()
    for (let offset = 0; offset < devices.length; offset += 100) {
      const batch = devices.slice(offset, offset + 100)
      let tickets: PushTicket[]
      try {
        tickets = await d.send(
          batch.map((device) => ({
            to: device.token,
            title: 'New plates are available',
            data: { type: 'catalog', version },
          }))
        )
      } catch {
        counts.failed += batch.length
        continue
      }
      for (const [index, device] of batch.entries()) {
        const ticket = tickets[index]
        if (ticket?.status === 'ok') counts.sent++
        else counts.failed++
        if (ticket?.details?.error === 'DeviceNotRegistered') {
          try {
            if (await d.store.prune(device)) counts.pruned++
          } catch {}
        }
      }
    }
    const result: CatalogPushResult = { status: 'completed', ...counts }
    await d.store.finish(version, result)
    return result
  } catch {
    const result: CatalogPushResult = { status: 'unavailable', ...counts }
    if (claimed) {
      try {
        await d.store.finish(version, result)
      } catch {}
    }
    return result
  }
}

/** Adapt Expo's push API to the sender interface and validate its ticket response. */
export function expoPushSender(
  accessToken: string,
  request: typeof fetch = fetch
): CatalogPushDeps['send'] {
  return async (messages) => {
    const response = await request('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error('Expo push request failed')
    const body = (await response.json()) as {
      data?: PushTicket[]
      errors?: unknown[]
    }
    if (
      body.errors?.length ||
      !Array.isArray(body.data) ||
      body.data.length !== messages.length ||
      body.data.some(
        (ticket) => ticket?.status !== 'ok' && ticket?.status !== 'error'
      )
    ) {
      throw new Error('Invalid Expo push response')
    }
    return body.data
  }
}

/**
 * Build the Firestore adapter for version-level push deduplication and device cleanup.
 */
export function firestoreCatalogPushStore(
  db: Firestore
): CatalogPushDeps['store'] {
  /** Address the notification record shared by retries of one published version. */
  const ref = (version: number) => db.doc(`catalogPushes/${version}`)
  return {
    /** Claim a version's push pass only when no other sender has claimed it. */
    async claim(version) {
      return db.runTransaction(async (transaction) => {
        const marker = ref(version)
        if ((await transaction.get(marker)).exists) return false
        transaction.create(marker, { version, status: 'claimed' })
        return true
      })
    },
    /**
     * Load registered devices with usable push tokens and the paths needed to prune
     * failures.
     */
    async devices() {
      const snapshot = await db.collectionGroup('devices').get()
      return snapshot.docs.flatMap((doc) => {
        const token = doc.get('expoPushToken')
        return /^users\/[^/]+\/devices\/[^/]+$/.test(doc.ref.path) &&
          typeof token === 'string' &&
          /^(ExpoPushToken|ExponentPushToken)\[[^\]]+\]$/.test(token)
          ? [{ path: doc.ref.path, token }]
          : []
      })
    },
    /**
     * Delete a failed registration only if its stored token still matches the one sent.
     */
    async prune(device) {
      return db.runTransaction(async (transaction) => {
        const ref = db.doc(device.path)
        if ((await transaction.get(ref)).get('expoPushToken') !== device.token)
          return false
        transaction.delete(ref)
        return true
      })
    },
    /**
     * Persist delivery totals on the notification record to close out the claimed
     * version.
     */
    async finish(version, result) {
      await ref(version).update({ ...result })
    },
  }
}

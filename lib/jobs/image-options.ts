export type ImageGroupOptions = {
  onlyMissingImage?: boolean
  method?: 'vision' | 'embeddings'
  colorSignal?: boolean
  backgroundMask?: boolean
  visionTiebreak?: boolean
}

export type GroupRuntime = { embeddings: boolean; backgroundMask: boolean; visionTiebreak: boolean; reason?: string; maskReason?: string; visionReason?: string }

export function imageGroupCapabilities(runtime?: GroupRuntime) {
  const unavailable = runtime?.reason ?? 'Needs a configured local grouping worker'
  const maskReady = !!runtime?.embeddings && runtime.backgroundMask
  return {
    'find-image': { available: true, label: 'Wikimedia Commons' },
    'enhance-image': { available: false, reason: 'Update the local worker to enhance images' },
    group: { available: !!runtime?.embeddings, reason: runtime?.embeddings ? undefined : unavailable },
    embeddings: { available: !!runtime?.embeddings, reason: runtime?.embeddings ? undefined : unavailable },
    colorSignal: { available: maskReady, reason: maskReady ? undefined : runtime?.maskReason ?? unavailable },
    backgroundMask: { available: maskReady, reason: maskReady ? undefined : runtime?.maskReason ?? unavailable },
    visionTiebreak: { available: !!runtime?.visionTiebreak, reason: runtime?.visionTiebreak ? undefined : runtime?.visionReason ?? 'Needs a reachable local vision service' },
    previewOnly: { available: false, reason: 'Preview-only runs need the connected run coordinator' },
    order: { available: false, reason: 'Order is manual: drag families to reorder' },
  }
}

export function commonsImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.href.length <= 2048 && url.protocol === 'https:' && url.hostname === 'upload.wikimedia.org' && !url.port && !url.username && !url.password
      && /^\/wikipedia\/commons\//.test(url.pathname) && /\.(?:png|jpe?g|webp)$/i.test(url.pathname)
      && !url.search && !url.hash ? url.href : null
  } catch { return null }
}

export function commonsSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.href.length <= 2048 && url.protocol === 'https:' && url.hostname === 'commons.wikimedia.org' && !url.port && !url.username && !url.password
      && url.pathname.startsWith('/wiki/File:') && !url.search && !url.hash ? url.href : null
  } catch { return null }
}

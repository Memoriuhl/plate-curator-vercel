export type ImageGroupOptions = {
  onlyMissingImage?: boolean
  method?: 'vision' | 'embeddings'
  colorSignal?: boolean
  backgroundMask?: boolean
  visionTiebreak?: boolean
}

export const imageGroupCapabilities = {
  'find-image': { available: true, label: 'Wikimedia Commons' },
  group: { available: true, label: 'DINOv2 embeddings · selected families' },
  colorSignal: { available: true, label: 'Use colour signal' },
  visionTiebreak: { available: true, label: 'Vision tiebreak' },
  embeddings: { available: true, label: 'DINOv2 embeddings' },
  backgroundMask: { available: true, label: 'MSER foreground mask' },
  order: { available: false, reason: 'Order is manual: drag families to reorder' },
} as const

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

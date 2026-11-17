export type ImageGroupOptions = {
  onlyMissingImage?: boolean
  method?: 'vision' | 'embeddings'
  colorSignal?: boolean
  backgroundMask?: boolean
  visionTiebreak?: boolean
}

export const imageGroupCapabilities = {
  'find-image': { available: true, label: 'Wikimedia Commons' },
  group: { available: true, label: 'Local vision · existing templates' },
  colorSignal: { available: true, label: 'Use colour signal' },
  visionTiebreak: { available: true, label: 'Vision tiebreak' },
  embeddings: { available: false, reason: 'Needs the Python DINOv2 runtime and embedding cache' },
  backgroundMask: { available: false, reason: 'Needs the Python OpenCV masking runtime' },
  order: { available: false, reason: 'Use manual ordering; no automatic implementation exists' },
} as const

export function parseImageGroupOptions(input: unknown): ImageGroupOptions | null {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const options = input as Record<string, unknown>
  if (Object.keys(options).some(key => !['onlyMissingImage', 'method', 'colorSignal', 'backgroundMask', 'visionTiebreak'].includes(key))) return null
  if (options.method !== undefined && options.method !== 'vision') return null
  if (options.backgroundMask !== undefined && options.backgroundMask !== false) return null
  for (const key of ['onlyMissingImage', 'colorSignal', 'visionTiebreak']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') return null
  }
  return { ...options } as ImageGroupOptions
}

export function commonsImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'upload.wikimedia.org' && !url.port && !url.username && !url.password
      && /^\/wikipedia\/commons\//.test(url.pathname) && /\.(?:png|jpe?g|webp)$/i.test(url.pathname)
      && !url.search && !url.hash ? url.href : null
  } catch { return null }
}

export function commonsSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'commons.wikimedia.org' && !url.port && !url.username && !url.password
      && url.pathname.startsWith('/wiki/File:') && !url.search && !url.hash ? url.href : null
  } catch { return null }
}

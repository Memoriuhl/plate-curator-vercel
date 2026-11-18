export type ImageEnhancementOptions = { upscale: boolean; crop: boolean; roundCorners: boolean }

export const defaultImageEnhancement: ImageEnhancementOptions = { upscale: true, crop: true, roundCorners: false }
export const enhancementOperations = ['upscale', 'crop', 'roundCorners'] as const
export const maxEnhancedImageBytes = 512 * 1024

export type EnhancedImageSuggestion = {
  kind: 'enhanced-image'
  stage: 'enhance-image'
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  sha256: string
}

export function parseEnhancedImageSuggestion(input: unknown): EnhancedImageSuggestion | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (value.kind !== 'enhanced-image' || value.stage !== 'enhance-image' ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    Object.keys(value).length !== 7) return null
  const { width, height, originalWidth, originalHeight } = value
  if (![width, height, originalWidth, originalHeight].every(size => Number.isSafeInteger(size) && Number(size) > 0) ||
    Number(width) * Number(height) > 16000000 || Number(originalWidth) * Number(originalHeight) > 16000000) return null
  return { kind: 'enhanced-image', stage: 'enhance-image', width: Number(width), height: Number(height),
    originalWidth: Number(originalWidth), originalHeight: Number(originalHeight), sha256: value.sha256 }
}

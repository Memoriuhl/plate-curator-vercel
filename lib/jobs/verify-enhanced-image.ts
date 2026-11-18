import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { maxEnhancedImageBytes, type EnhancedImageSuggestion } from './image-enhancement'

export async function verifyEnhancedImage(value: unknown, suggestion: Pick<EnhancedImageSuggestion, 'sha256' | 'width' | 'height'>): Promise<Buffer | null> {
  if (typeof value !== 'string' || value.length > Math.ceil(maxEnhancedImageBytes / 3) * 4) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maxEnhancedImageBytes || bytes.toString('base64') !== value ||
    createHash('sha256').update(bytes).digest('hex') !== suggestion.sha256) return null
  try {
    const image = sharp(bytes, { limitInputPixels: 16000000, failOn: 'error' })
    const { format, pages, width, height } = await image.metadata()
    if (format !== 'webp' || (pages ?? 1) !== 1 || width !== suggestion.width || height !== suggestion.height) return null
    await image.resize({ width: 1 }).raw().toBuffer()
    return bytes
  } catch { return null }
}

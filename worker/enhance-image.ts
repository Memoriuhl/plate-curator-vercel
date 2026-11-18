import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { defaultImageEnhancement, maxEnhancedImageBytes, type ImageEnhancementOptions } from '../lib/jobs/image-enhancement'
import type { WorkerDeps } from './run'

const imageLimits = { limitInputPixels: 16000000 }
const targetPlateWidth = 640

export async function enhanceImage(bytes: Buffer, options: ImageEnhancementOptions) {
  const normalized = await sharp(bytes, imageLimits).rotate().png().toBuffer({ resolveWithObject: true })
  const originalWidth = normalized.info.width, originalHeight = normalized.info.height
  let input = normalized.data
  let width = originalWidth, height = originalHeight
  if (options.crop) {
    const trim = await sharp(input, imageLimits).trim({ threshold: 24 }).png().toBuffer({ resolveWithObject: true })
    const area = trim.info.width * trim.info.height
    if (trim.info.width >= 80 && trim.info.height >= 40 && area >= originalWidth * originalHeight * 0.35) {
      input = trim.data
      width = trim.info.width
      height = trim.info.height
    }
  }

  if (options.upscale && width < targetPlateWidth) {
    const resized = await sharp(input, imageLimits).resize({ width: Math.min(width * 2, targetPlateWidth), kernel: 'lanczos3' }).png()
      .toBuffer({ resolveWithObject: true })
    input = resized.data
    width = resized.info.width
    height = resized.info.height
  }

  const output = sharp(input, imageLimits)
  if (options.roundCorners) {
    const radius = Math.max(1, Math.round(Math.min(width, height) * 0.06))
    const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></svg>`)
    output.composite([{ input: mask, blend: 'dest-in' }])
  }
  const webp = await output.webp({ quality: 86, effort: 4 }).toBuffer()
  if (webp.length > maxEnhancedImageBytes) throw new Error('Enhanced image exceeds the supported size')
  return { webp, width, height, originalWidth, originalHeight }
}

export function createEnhanceImageRunner(readImage: WorkerDeps['readImage']): NonNullable<WorkerDeps['suggestFields']> {
  return async ({ plate, options }) => {
    const metadata = { backend: 'local', model: 'sharp', promptVersion: 'enhance-image-v1' }
    const source = plate.imageUrl || plate.image
    if (!source) return { ...metadata, stageError: 'missing_image' }
    let bytes: Buffer
    try { bytes = Buffer.from(await readImage(source), 'base64') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...metadata, stageError: 'missing_image' }
      throw error
    }
    const { webp, ...dimensions } = await enhanceImage(bytes, { ...defaultImageEnhancement, ...options })
    return { ...metadata, enhancedImage: webp.toString('base64'), fieldSuggestion: {
      kind: 'enhanced-image', stage: 'enhance-image', ...dimensions, sha256: createHash('sha256').update(webp).digest('hex'),
    } }
  }
}

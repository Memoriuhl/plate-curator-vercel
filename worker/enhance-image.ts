import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
  defaultImageEnhancement,
  maxEnhancedImageBytes,
  type EnhancementStep,
  type ImageEnhancementOptions,
} from '../lib/jobs/image-enhancement'
import type { WorkerDeps } from './run'

const imageLimits = { limitInputPixels: 16000000 }
const targetPlateWidth = 640

export async function enhanceImage(
  bytes: Buffer,
  options: ImageEnhancementOptions,
  onExport?: () => Promise<void>
) {
  const normalized = await sharp(bytes, imageLimits)
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true })
  const originalWidth = normalized.info.width,
    originalHeight = normalized.info.height
  let input = normalized.data
  let width = originalWidth,
    height = originalHeight
  const checkpoints: {
    input: Buffer
    step: EnhancementStep
    width: number
    height: number
  }[] = []
  function capture(step: EnhancementStep) {
    checkpoints.push({ input, step, width, height })
  }
  capture('original')
  if (options.crop) {
    if (width >= 80 && height >= 40) {
      const trim = await sharp(input, imageLimits)
        .trim({ threshold: 24 })
        .png()
        .toBuffer({ resolveWithObject: true })
      if (
        trim.info.width >= 80 &&
        trim.info.height >= 40 &&
        trim.info.width * trim.info.height >=
          originalWidth * originalHeight * 0.35
      ) {
        input = trim.data
        width = trim.info.width
        height = trim.info.height
      }
    }
    capture('crop')
  }
  if (options.upscale) {
    if (width < targetPlateWidth) {
      const resized = await sharp(input, imageLimits)
        .resize({
          width: Math.min(width * 2, targetPlateWidth),
          kernel: 'lanczos3',
        })
        .png()
        .toBuffer({ resolveWithObject: true })
      input = resized.data
      width = resized.info.width
      height = resized.info.height
    }
    capture('upscale')
  }
  if (options.roundCorners) {
    const radius = Math.max(1, Math.round(Math.min(width, height) * 0.06))
    const mask = Buffer.from(
      `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></svg>`
    )
    input = await sharp(input, imageLimits)
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer()
    capture('roundCorners')
  }
  await onExport?.()
  const frames = []
  for (const checkpoint of checkpoints) {
    const webp = await sharp(checkpoint.input, imageLimits)
      .webp({ quality: 86, effort: 4 })
      .toBuffer()
    if (webp.length > maxEnhancedImageBytes)
      throw new Error('Enhanced image exceeds the supported size')
    frames.push({
      webp,
      details: {
        step: checkpoint.step,
        width: checkpoint.width,
        height: checkpoint.height,
        sha256: createHash('sha256').update(webp).digest('hex'),
      },
    })
  }
  return {
    webp: frames.at(-1)!.webp,
    width,
    height,
    originalWidth,
    originalHeight,
    frames,
  }
}

export function createEnhanceImageRunner(
  readImage: WorkerDeps['readImage']
): NonNullable<WorkerDeps['suggestFields']> {
  return async ({ plate, options, onPhase }) => {
    const metadata = {
      backend: 'local',
      model: 'sharp',
      promptVersion: 'enhance-image-v2',
    }
    const source = plate.imageUrl || plate.image
    if (!source) return { ...metadata, stageError: 'missing_image' }
    let bytes: Buffer
    try {
      bytes = Buffer.from(await readImage(source), 'base64')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { ...metadata, stageError: 'missing_image' }
      throw error
    }
    const { webp, frames, ...dimensions } = await enhanceImage(
      bytes,
      { ...defaultImageEnhancement, ...options },
      onPhase ? () => onPhase(1) : undefined
    )
    return {
      ...metadata,
      enhancedImage: webp.toString('base64'),
      enhancedImageFrames: frames
        .slice(0, -1)
        .map((frame) => frame.webp.toString('base64')),
      fieldSuggestion: {
        kind: 'enhanced-image',
        stage: 'enhance-image',
        ...dimensions,
        sha256: frames.at(-1)!.details.sha256,
        frames: frames.map((frame) => frame.details),
      },
    }
  }
}

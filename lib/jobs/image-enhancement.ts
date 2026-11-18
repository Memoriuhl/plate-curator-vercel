export type ImageEnhancementOptions = {
  upscale: boolean
  crop: boolean
  roundCorners: boolean
}

export const defaultImageEnhancement: ImageEnhancementOptions = {
  upscale: true,
  crop: true,
  roundCorners: false,
}
export const enhancementOperations = [
  'crop',
  'upscale',
  'roundCorners',
] as const
export const maxEnhancedImageBytes = 512 * 1024

type ImageShape = { width: number; height: number; sha256: string }
export const enhancementStepLabels = {
  original: 'Original',
  crop: 'Crop margins',
  upscale: 'Upscale',
  roundCorners: 'Round corners',
}
export type EnhancementStep = keyof typeof enhancementStepLabels
export type EnhancementFrame = ImageShape & { step: EnhancementStep }

export type EnhancedImageSuggestion = ImageShape & {
  kind: 'enhanced-image'
  stage: 'enhance-image'
  originalWidth: number
  originalHeight: number
  frames?: EnhancementFrame[]
}

function validDimensions(width: unknown, height: unknown) {
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= 16000000
  )
}

function imageShape(value: Record<string, unknown>) {
  return typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    validDimensions(value.width, value.height)
    ? {
        width: Number(value.width),
        height: Number(value.height),
        sha256: value.sha256,
      }
    : null
}

export function parseEnhancedImageSuggestion(
  input: unknown
): EnhancedImageSuggestion | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const shape = imageShape(value)
  if (
    value.kind !== 'enhanced-image' ||
    value.stage !== 'enhance-image' ||
    !shape ||
    !validDimensions(value.originalWidth, value.originalHeight) ||
    Object.keys(value).some(
      (key) =>
        ![
          'kind',
          'stage',
          'width',
          'height',
          'originalWidth',
          'originalHeight',
          'sha256',
          'frames',
        ].includes(key)
    )
  )
    return null

  const { originalWidth, originalHeight } = value
  const suggestion: EnhancedImageSuggestion = {
    kind: 'enhanced-image',
    stage: 'enhance-image',
    ...shape,
    originalWidth: Number(originalWidth),
    originalHeight: Number(originalHeight),
  }
  if (value.frames === undefined) return suggestion
  if (
    !Array.isArray(value.frames) ||
    value.frames.length < 2 ||
    value.frames.length > enhancementOperations.length + 1
  )
    return null
  const frames: EnhancementFrame[] = []
  const steps = ['original', ...enhancementOperations]
  let previous = -1
  for (const raw of value.frames) {
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 4)
      return null
    const frame = imageShape(raw)
    const index = steps.indexOf(raw.step)
    if (!frame || index <= previous || (!frames.length && index !== 0))
      return null
    previous = index
    frames.push({ ...frame, step: raw.step })
  }
  const first = frames[0],
    last = frames.at(-1)!
  if (
    first.width !== originalWidth ||
    first.height !== originalHeight ||
    last.width !== shape.width ||
    last.height !== shape.height ||
    last.sha256 !== shape.sha256
  )
    return null
  return { ...suggestion, frames }
}

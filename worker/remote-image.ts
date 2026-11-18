import sharp from 'sharp'
import { commonsImageUrl } from '../lib/jobs/image-options'

/**
 * Read a response into memory only while its declared and streamed sizes fit the byte
 * limit.
 */
export async function boundedResponse(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Remote content unavailable')
  }
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('Remote content too large')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('Remote content too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/**
 * Download a supported Commons image, validate its media and dimensions and return the
 * checked bytes.
 */
export async function readCommonsImage(
  value: string,
  request: typeof fetch = fetch
): Promise<Buffer> {
  const url = commonsImageUrl(value)
  if (!url)
    throw new Error('Only Wikimedia Commons raster images are supported')
  const response = await request(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'LocalMediaReview/1.0' },
  })
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(
      response.headers.get('content-type')?.split(';')[0].trim() ?? ''
    )
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Unsupported image content type')
  }
  const bytes = await boundedResponse(response, 8 * 1024 * 1024)
  const metadata = await sharp(bytes, {
    limitInputPixels: 16000000,
    animated: false,
  }).metadata()
  if (
    !['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
    !metadata.width ||
    !metadata.height ||
    metadata.width < 80 ||
    metadata.height < 40 ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error('Unsupported image content')
  await sharp(bytes, { limitInputPixels: 16000000 })
    .resize({
      width: 640,
      height: 400,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer()
  return bytes
}

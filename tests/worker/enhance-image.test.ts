import { expect, test } from 'vitest'
import sharp from 'sharp'
import { enhanceImage } from '../../worker/enhance-image'

const off = { upscale: false, crop: false, roundCorners: false }

async function borderedPlate() {
  return sharp({
    create: { width: 320, height: 160, channels: 3, background: 'red' },
  })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: 'white' })
    .png()
    .toBuffer()
}

test('crop, upscale and corner masking change pixels independently', async () => {
  const input = await borderedPlate()
  const original = await enhanceImage(input, off)
  expect(original).toMatchObject({
    width: 360,
    height: 200,
    originalWidth: 360,
    originalHeight: 200,
  })
  const cropped = await enhanceImage(input, { ...off, crop: true })
  expect(cropped).toMatchObject({ width: 320, height: 160 })
  const upscaled = await enhanceImage(input, { ...off, upscale: true })
  expect(upscaled).toMatchObject({ width: 640, height: 356 })
  const rounded = await enhanceImage(input, { ...off, roundCorners: true })
  expect(rounded).toMatchObject({ width: 360, height: 200 })
  const { data, info } = await sharp(rounded.webp)
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect(info.channels).toBe(4)
  expect(data[3]).toBe(0)
  expect(data[(100 * info.width + 180) * info.channels + 3]).toBe(255)
  const combined = await enhanceImage(input, {
    ...off,
    crop: true,
    upscale: true,
  })
  expect(combined).toMatchObject({ width: 640, height: 320 })
})

test('records the actual pixels at each enabled step in processing order', async () => {
  const result = await enhanceImage(await borderedPlate(), {
    crop: true,
    upscale: true,
    roundCorners: true,
  })
  expect(
    result.frames.map(({ details }) => [
      details.step,
      details.width,
      details.height,
    ])
  ).toEqual([
    ['original', 360, 200],
    ['crop', 320, 160],
    ['upscale', 640, 320],
    ['roundCorners', 640, 320],
  ])
  const observed = await Promise.all(
    result.frames.map(({ webp }) => sharp(webp).metadata())
  )
  expect(observed.map(({ hasAlpha }) => hasAlpha)).toEqual([
    false,
    false,
    false,
    true,
  ])
  expect(result.webp.equals(result.frames[3].webp)).toBe(true)
  expect(new Set(result.frames.map(({ details }) => details.sha256)).size).toBe(
    4
  )
})

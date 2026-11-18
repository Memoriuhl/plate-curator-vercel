import type { Plate } from './types'

const imagePath = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\.webp$/

/**
 * Resolve a plate's explicit or catalog-hosted image while validating the storage path.
 */
export function plateImageUrl(
  plate: Plate,
  base: string | null
): string | null {
  if (typeof plate.imageUrl === 'string' && plate.imageUrl.length > 0)
    return plate.imageUrl
  if (
    !base ||
    typeof plate.image !== 'string' ||
    !imagePath.test(plate.image) ||
    plate.image.split('/').includes('..')
  )
    return null
  return `${base.replace(/\/+$/, '')}/plates/${plate.image}`
}

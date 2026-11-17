import { readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { readCommonsImage } from './remote-image'

export function imageReader(gameRepo: string) {
  const root = resolve(gameRepo, 'assets', 'plates')
  return async (image: string): Promise<string> => {
    if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && /^https?:/i.test(image)) return (await readCommonsImage(image)).toString('base64')
    const path = resolve(root, image)
    const rel = relative(root, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Image path leaves plates directory')
    return (await readFile(path)).toString('base64')
  }
}

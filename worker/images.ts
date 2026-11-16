import { readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'

export function imageReader(gameRepo: string) {
  const root = resolve(gameRepo, 'assets', 'plates')
  return async (image: string): Promise<string> => {
    const path = resolve(root, image)
    const rel = relative(root, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Image path leaves plates directory')
    return (await readFile(path)).toString('base64')
  }
}

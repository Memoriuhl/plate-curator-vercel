import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { ResearchStateStore } from '../state'

/** Store local Eve research state on disk so runs can resume across process restarts. */
export function fileResearchState(directory: string): ResearchStateStore {
  /** Hash a state key into a safe local filename inside the configured directory. */
  const filename = (key: string) =>
    join(directory, createHash('sha256').update(key).digest('hex') + '.json')
  /** Read a stored research value and treat a missing state file as empty. */
  async function read<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(filename(key), 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return {
    read,
    /**
     * Lock, replace and clean up the local state file so updates survive interruptions
     * and concurrent writes.
     */
    async update<T, R>(
      key: string,
      change: (value: T | null) => { value: T; result: R }
    ) {
      await mkdir(directory, { recursive: true })
      const path = filename(key)
      const lockPath = path + '.lock'
      let lock: Awaited<ReturnType<typeof open>> | undefined
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          lock = await open(lockPath, 'wx', 0o600)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      if (!lock)
        throw new Error('Research state is locked; no request was authorized')
      const temporary = path + '.' + randomUUID() + '.tmp'
      try {
        const changed = change(await read<T>(key))
        await writeFile(temporary, JSON.stringify(changed.value), {
          mode: 0o600,
        })
        await rename(temporary, path)
        return changed.result
      } finally {
        await lock.close()
        await unlink(lockPath)
        await unlink(temporary).catch(() => undefined)
      }
    },
  }
}

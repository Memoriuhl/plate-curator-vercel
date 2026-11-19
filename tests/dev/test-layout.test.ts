import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')

/** Every file under a top-level folder, as a repository-relative path. */
function filesIn(folder: string) {
  return (
    readdirSync(path.join(root, folder), { recursive: true }) as string[]
  ).map((file) => path.join(folder, file))
}

const sourceFolders = [
  'app',
  'components',
  'lib',
  'scripts',
  'worker',
  'tests',
  'tests-emulator',
]

test('jsdom tests are chosen by their .dom.test name, not a per-file environment comment', () => {
  const tests = filesIn('tests').filter((file) =>
    /\.test\.(ts|tsx)$/.test(file)
  )
  // Split so this file does not match its own check.
  const comment = '@vitest-' + 'environment'
  const overridden = tests.filter((file) =>
    readFileSync(path.join(root, file), 'utf8').includes(comment)
  )
  expect(overridden).toEqual([])
})

test('.dom.test files live under tests/, where the jsdom project picks them up', () => {
  const misplaced = sourceFolders
    .flatMap(filesIn)
    .filter(
      (file) =>
        /\.dom\.test\.(ts|tsx)$/.test(file) &&
        !file.startsWith(`tests${path.sep}`)
    )
  expect(misplaced).toEqual([])
})

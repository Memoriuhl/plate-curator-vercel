import { expect, test } from 'vitest'
import {
  migrationUsage,
  parseMigrationArgs,
} from '../../lib/review/migration/migration-args'

test('standard environments parse whatever this checkout deploys as', () => {
  for (const env of ['development', 'production', 'preview:feat/x']) {
    expect(parseMigrationArgs(['--env', env], undefined)).toEqual({
      env,
      apply: false,
    })
    expect(parseMigrationArgs(['--env', env, '--apply'], 'checkpoint')).toEqual(
      { env, apply: true }
    )
  }
})

test('a named environment parses when this checkout runs as it', () => {
  expect(parseMigrationArgs(['--env', 'checkpoint'], 'checkpoint')).toEqual({
    env: 'checkpoint',
    apply: false,
  })
})

test('a named environment this checkout does not run as is refused', () => {
  // A typo must not fold, or with --apply create, a draft nobody reads.
  for (const vercelEnv of [undefined, 'development', 'checkpoint']) {
    expect(() =>
      parseMigrationArgs(['--env', 'checkpont', '--apply'], vercelEnv)
    ).toThrow(/VERCEL_ENV=checkpont/)
  }
})

test('names the runtime never produces are usage errors', () => {
  // A preview deployment's review environment always carries its branch.
  for (const env of ['preview', 'preview:', 'check point', 'a/b', '']) {
    expect(() => parseMigrationArgs(['--env', env], env)).toThrow(
      migrationUsage
    )
  }
})

test('missing or unknown arguments are usage errors', () => {
  expect(() => parseMigrationArgs([], 'development')).toThrow(migrationUsage)
  expect(() => parseMigrationArgs(['--env'], 'development')).toThrow(
    migrationUsage
  )
  expect(() =>
    parseMigrationArgs(['--env', 'development', '--force'], 'development')
  ).toThrow(migrationUsage)
})

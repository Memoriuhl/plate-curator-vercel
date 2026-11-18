import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const NOREPLY = '49572768+Memoriuhl@users.noreply.github.com'

/**
 * Strip inherited Git configuration so isolated hook tests use their own identities and
 * settings.
 */
function isolatedEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key === 'CI' || key === 'HYGIENE_DENYLIST')
      delete env[key]
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  }
}

/** Create a temporary repository with the real hooks and clean it up after the test. */
function freshRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-hooks-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(join(REPO_ROOT, '.githooks'), join(dir, '.githooks'), {
    recursive: true,
  })
  cpSync(
    join(REPO_ROOT, 'scripts/hygiene/check.mjs'),
    join(dir, 'scripts/hygiene/check.mjs')
  )
  /** Run Git in the hook fixture with its isolated environment. */
  const git = (args, extraEnv) =>
    spawnSync('git', args, {
      cwd: dir,
      env: isolatedEnv(extraEnv),
      encoding: 'utf8',
    })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Hygiene Test'])
  git(['config', 'user.email', NOREPLY])
  git(['config', 'core.hooksPath', '.githooks'])
  /**
   * Stage a fixture file and attempt its commit so the hooks run as they would locally.
   */
  const commit = (file, content, message, extraEnv) => {
    writeFileSync(join(dir, file), content)
    git(['add', '-A'])
    return git(['commit', '-q', '-m', message], extraEnv)
  }
  return { dir, git, commit }
}

test('a clean commit with the no-reply identity goes through', (t) => {
  const { commit } = freshRepo(t)
  const result = commit('a.txt', 'hello\n', 'chore: start', {
    HYGIENE_DENYLIST: 'example-secret-host',
  })
  assert.equal(result.status, 0, result.stderr)
})

test('a foreign author email is refused without echoing it', (t) => {
  const { commit } = freshRepo(t)
  const result = commit('a.txt', 'hello\n', 'chore: start', {
    HYGIENE_DENYLIST: 'example-secret-host',
    GIT_AUTHOR_EMAIL: 'someone@example.com',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /email/)
  assert.ok(!result.stderr.includes('someone@example.com'))
})

test('a foreign author passed with --author is refused', (t) => {
  const { dir, git } = freshRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git(['add', '-A'])
  const result = git(
    [
      'commit',
      '-q',
      '-m',
      'chore: start',
      '--author',
      'Someone <someone@example.com>',
    ],
    {
      HYGIENE_DENYLIST: 'example-secret-host',
    }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /email/)
})

test('a denylisted string in staged content is refused without echoing it', (t) => {
  const { commit } = freshRepo(t)
  const result = commit(
    'a.txt',
    'url: https://EXAMPLE-SECRET-HOST/x\n',
    'chore: start',
    {
      HYGIENE_DENYLIST: 'example-secret-host',
    }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /denylisted.*a\.txt:1/)
  assert.ok(!/secret-host/i.test(result.stderr))
})

test('a large staged diff is scanned through its final line', (t) => {
  const { commit } = freshRepo(t)
  const filler = ('ordinary content '.repeat(20).trimEnd() + '\n').repeat(4000)
  const result = commit(
    'large.txt',
    filler + 'example-secret-host\n',
    'chore: reformat',
    { HYGIENE_DENYLIST: 'example-secret-host' }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /denylisted.*large\.txt:4001/)
  assert.ok(!/secret-host/i.test(result.stderr))
})

test('a denylisted string or a Co-Authored-By trailer in the message is refused', (t) => {
  const { commit } = freshRepo(t)
  const env = { HYGIENE_DENYLIST: 'example-secret-host' }
  const denylisted = commit(
    'a.txt',
    'one\n',
    'chore: mention example-secret-host',
    env
  )
  assert.notEqual(denylisted.status, 0)
  assert.match(denylisted.stderr, /denylisted/)
  assert.ok(!/secret-host/i.test(denylisted.stderr))
  const trailer = commit(
    'a.txt',
    'two\n',
    'chore: start\n\nCo-Authored-By: Someone <someone@example.com>',
    env
  )
  assert.notEqual(trailer.status, 0)
  assert.match(trailer.stderr, /trailer/)
})

test('locally without a denylist the commit runs the other checks and warns', (t) => {
  const { commit } = freshRepo(t)
  const result = commit('a.txt', 'hello\n', 'chore: start')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /denylist checks skipped/)
})

test('the local .hygiene-denylist file is used when the env var is absent', (t) => {
  const { dir, commit } = freshRepo(t)
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.hygiene-denylist\n')
  writeFileSync(
    join(dir, '.hygiene-denylist'),
    '# private\nexample-secret-host\n'
  )
  const result = commit('a.txt', 'example-secret-host\n', 'chore: start')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /denylisted.*a\.txt:1/)
})

test('in CI an empty denylist env var refuses the commit', (t) => {
  const { commit } = freshRepo(t)
  const result = commit('a.txt', 'hello\n', 'chore: start', {
    CI: 'true',
    HYGIENE_DENYLIST: '',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HYGIENE_DENYLIST/)
})

test("a linked worktree uses the main checkout's .hygiene-denylist", (t) => {
  const { dir, git } = freshRepo(t)
  writeFileSync(
    join(dir, '.git', 'info', 'exclude'),
    '.hygiene-denylist\nwt/\n'
  )
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'chore: base'])
  writeFileSync(join(dir, '.hygiene-denylist'), 'example-secret-host\n')
  git(['worktree', 'add', '-q', '-b', 'side', 'wt'])
  const worktree = join(dir, 'wt')
  writeFileSync(join(worktree, 'a.txt'), 'example-secret-host\n')
  /** Run Git in the linked test worktree with isolated configuration. */
  const run = (args) =>
    spawnSync('git', args, {
      cwd: worktree,
      env: isolatedEnv(),
      encoding: 'utf8',
    })
  run(['add', '-A'])
  const result = run(['commit', '-q', '-m', 'chore: side'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /denylisted.*a\.txt:1/)
})

test('editor comment lines in the message are ignored, as git strips them', (t) => {
  const { dir, git } = freshRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git(['add', '-A'])
  const messageFile = join(dir, '.git', 'MSG')
  writeFileSync(
    messageFile,
    'chore: start\n\n# Changes to be committed:\n#\tdeleted: old/example-secret-host.txt\n'
  )
  const result = git(['commit', '-q', '--cleanup=strip', '-F', messageFile], {
    HYGIENE_DENYLIST: 'example-secret-host',
  })
  assert.equal(result.status, 0, result.stderr)
})

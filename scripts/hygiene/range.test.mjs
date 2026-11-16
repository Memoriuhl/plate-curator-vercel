import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check.mjs', import.meta.url));
const email = '49572768+Memoriuhl@users.noreply.github.com';

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-range-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') && !['CI', 'HYGIENE_DENYLIST'].includes(key)));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const git = (args, extra = {}) => {
    const result = spawnSync('git', args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Hygiene Test']);
  git(['config', 'user.email', email]);
  const commit = (message = 'chore: update', extra = {}) => {
    git(['add', '-A']);
    git(['commit', '--allow-empty', '-q', '-m', message], extra);
    return git(['rev-parse', 'HEAD']);
  };
  const base = commit();
  const check = (start = base, head = 'HEAD', extra = {}) => spawnSync(process.execPath,
    [checker, 'range', start, head], {
      cwd: dir, env: { ...env, CI: 'true', HYGIENE_DENYLIST: 'private-fixture', ...extra }, encoding: 'utf8',
    });
  return { dir, git, commit, base, check };
}

test('clean and empty ranges pass, excluding the base commit', (t) => {
  const { commit, check } = repository(t);
  const base = commit('private-fixture');
  assert.equal(check(base).status, 0);
  commit();
  assert.equal(check(base).status, 0);
});

for (const identity of ['AUTHOR', 'COMMITTER']) {
  test(`range checks every ${identity.toLowerCase()} identity without printing it`, (t) => {
    const { commit, check } = repository(t);
    commit('chore: update', { [`GIT_${identity}_EMAIL`]: 'foreign@example.com' });
    commit();
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /email/);
    assert.ok(!result.stderr.includes('foreign@example.com'));
  });
}

test('the hosting service identity is accepted only as committer', (t) => {
  const { commit, check } = repository(t);
  commit('chore: merge', { GIT_COMMITTER_EMAIL: 'noreply@github.com' });
  assert.equal(check().status, 0);
  commit('chore: update', { GIT_AUTHOR_EMAIL: 'noreply@github.com' });
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /email/);
});

test('range checks earlier messages and trailers without printing message text', (t) => {
  const { commit, check } = repository(t);
  commit('chore: private-fixture\n\nCo-Authored-By: Fixture <fixture@example.com>');
  commit();
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /denylisted/);
  assert.match(result.stderr, /trailer/);
  assert.doesNotMatch(result.stderr, /private-fixture|fixture@example.com/);
});

test('range catches added lines and paths even when later deleted', (t) => {
  const { dir, git, commit, check } = repository(t);
  writeFileSync(join(dir, 'notes.txt'), 'private-fixture\n');
  writeFileSync(join(dir, 'private-fixture.txt'), 'safe\n');
  commit();
  git(['rm', 'notes.txt', 'private-fixture.txt']);
  commit();
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /denylisted.*notes.txt:1/);
  assert.match(result.stderr, /withheld/);
  assert.ok(!result.stderr.includes('private-fixture'));
});

test('range checks side-branch commits and merge resolution additions', (t) => {
  const { dir, git, commit, check } = repository(t);
  git(['switch', '-q', '-c', 'side']);
  commit('chore: private-fixture');
  git(['switch', '-q', 'main']);
  commit();
  git(['merge', '--no-ff', '--no-commit', 'side']);
  writeFileSync(join(dir, 'merge.txt'), 'private-fixture\n');
  commit('chore: merge');
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit message/);
  assert.match(result.stderr, /merge.txt:1/);
});

test('missing CI denylist and invalid revisions fail without exposing inputs', (t) => {
  const { check } = repository(t);
  const missing = check(undefined, undefined, { HYGIENE_DENYLIST: '' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /HYGIENE_DENYLIST/);
  const invalid = check('private-fixture');
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes('private-fixture'));
});

test('a new-branch range checks root commits and secret shapes', (t) => {
  const { dir, commit, check } = repository(t);
  writeFileSync(join(dir, 'key.txt'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '));
  commit();
  const result = check('0'.repeat(40));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret.*key.txt:1/);
  assert.ok(!result.stderr.includes('-----BEGIN'));
});

test('removed lines and unchanged content are excluded from the range', (t) => {
  const { dir, commit, check } = repository(t);
  writeFileSync(join(dir, 'notes.txt'), 'private-fixture\nkeep\n');
  const base = commit();
  writeFileSync(join(dir, 'notes.txt'), 'keep\n');
  commit();
  assert.equal(check(base).status, 0);
});

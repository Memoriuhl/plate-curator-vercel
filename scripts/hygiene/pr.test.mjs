import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check.mjs', import.meta.url));
const address = [100, 64, 1, 2].join('.');
/** Run the pull request check with controlled title, body and CI settings. */
const check = (extra = {}) => spawnSync(process.execPath, [checker, 'pull-request'], {
  encoding: 'utf8',
  env: { ...process.env, CI: 'true', HYGIENE_DENYLIST: 'private-fixture',
    PR_TITLE: 'chore: update', PR_BODY: 'Verify the dev server.', ...extra },
});

test('clean PR metadata passes without executing shell-shaped text', () => {
  assert.equal(check({ PR_BODY: 'Literal $(exit 99) and `exit 99`' }).status, 0);
});

for (const field of ['PR_TITLE', 'PR_BODY']) {
  for (const [kind, value] of [
    ['address', address], ['denylisted', 'private-fixture'],
    ['trailer', 'Co-Authored-By: Fixture <fixture@example.com>'],
    ['secret', ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')],
  ]) {
    test(`PR ${field} rejects ${kind} without disclosing its value`, () => {
      const result = check({ [field]: value });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`hygiene: ${kind}: pull request`));
      assert.ok(!result.stderr.includes(value));
      assert.ok(!result.stdout.includes(value));
    });
  }
}

test('PR checks fail closed without the CI denylist', () => {
  const result = check({ HYGIENE_DENYLIST: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HYGIENE_DENYLIST/);
});

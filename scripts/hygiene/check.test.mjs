import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations, resolveDenylist } from './check.mjs';

const NOREPLY = '49572768+Memoriuhl@users.noreply.github.com';

test('committer exceptions never apply to authors', () => {
  assert.deepEqual(findViolations({ authorEmails: [NOREPLY], committerEmails: ['noreply@github.com'] }), []);
  assert.equal(findViolations({ committerEmails: ['foreign@example.com'] })[0]?.kind, 'email');
  assert.equal(findViolations({ authorEmails: ['noreply@github.com'] })[0]?.kind, 'email');
});

const privateAddresses = [
  [10, 0, 0, 0], [10, 255, 255, 255],
  [100, 64, 0, 0], [100, 127, 255, 255],
  [172, 16, 0, 0], [172, 31, 255, 255],
  [192, 168, 0, 0], [192, 168, 255, 255],
].map((octets) => octets.join('.'));

test('private and overlay addresses are rejected in messages without disclosure', () => {
  for (const address of privateAddresses) {
    const violations = findViolations({ text: `host: https://${address}:8080/path` });
    assert.deepEqual(violations, [{ kind: 'address', detail: 'line 1' }]);
    assert.ok(!JSON.stringify(violations).includes(address));
  }
});

test('public, loopback, unspecified, invalid and version strings are allowed', () => {
  const allowed = [[100, 63, 255, 255], [100, 128, 0, 0], [172, 15, 255, 255],
    [172, 32, 0, 0], [192, 167, 0, 1], [127, 0, 0, 1], [0, 0, 0, 0], [10, 256, 0, 1]];
  for (const octets of allowed) assert.deepEqual(findViolations({ text: octets.join('.') }), []);
  assert.deepEqual(findViolations({ text: 'versions 10.2 and 1.10.0' }), []);
});

test('addresses in added lines and paths are withheld from all diagnostics', () => {
  for (const address of privateAddresses) {
    const path = `notes/${address}.txt`;
    const text = [`diff --git a/${path} b/${path}`, 'new file mode 100644',
      '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1 @@', `+${address} private-fixture`].join('\n');
    const violations = findViolations({ text, format: 'diff', denylist: ['private-fixture'] });
    assert.deepEqual(violations.map(({ kind }) => kind), ['address', 'denylisted', 'address']);
    assert.ok(!JSON.stringify(violations).includes(address));
    assert.match(JSON.stringify(violations), /withheld path/);
  }
});

test('removed addresses are allowed while added addresses are rejected by location', () => {
  const address = privateAddresses[0];
  const header = ['diff --git a/notes.txt b/notes.txt', '--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@'];
  assert.deepEqual(findViolations({ text: [...header, `-${address}`, '+localhost'].join('\n'), format: 'diff' }), []);
  assert.deepEqual(findViolations({ text: [...header, '-localhost', `+${address}`].join('\n'), format: 'diff' }),
    [{ kind: 'address', detail: 'notes.txt:1' }]);
});

test('the no-reply author email is accepted', () => {
  assert.deepEqual(findViolations({ authorEmails: [NOREPLY, NOREPLY] }), []);
});

test('any other author email is rejected as an email violation', () => {
  const violations = findViolations({ authorEmails: [NOREPLY, 'someone@example.com'] });
  assert.deepEqual(violations.map((v) => v.kind), ['email']);
  assert.ok(!violations[0].detail.includes('someone@example.com'));
});

test('a denylisted string matches case-insensitively and the report omits the matched text', () => {
  const violations = findViolations({
    text: 'first line\nDeploy to Example-Secret-Host.internal\n',
    denylist: ['example-secret-host'],
  });
  assert.deepEqual(violations, [{ kind: 'denylisted', detail: 'line 2' }]);
});

const kindsIn = (text) => findViolations({ text }).map((v) => v.kind);

// Fixtures are assembled at runtime so this file passes its own hook and secret scanners.
const keyHeader = (type) => ['-----BEGIN', `${type}-----`].join(' ');

test('a private-key header is flagged as a secret', () => {
  assert.deepEqual(kindsIn(keyHeader('RSA PRIVATE KEY')), ['secret']);
  assert.deepEqual(kindsIn(keyHeader('OPENSSH PRIVATE KEY')), ['secret']);
  assert.deepEqual(kindsIn(keyHeader('PRIVATE KEY')), ['secret']);
  assert.deepEqual(kindsIn(keyHeader('PGP PRIVATE KEY BLOCK')), ['secret']);
});

test('obvious token shapes are flagged as secrets without echoing them', () => {
  const tokens = [
    `token = "ghp_${'a1B2'.repeat(9)}"`,
    `github_pat_${'A1b2C3d4E5'.repeat(3)}`,
    `aws_access_key_id = ${'AKIA'}IOSFODNN7EXAMPLE`,
    `SLACK=${'xoxb'}-123456789012-abcdefABCDEF`,
    `key: sk-${'x9Y8z7W6v5'.repeat(3)}`,
  ];
  const names = ['GitHub token', 'GitHub token', 'AWS access key id', 'Slack token', 'secret key'];
  tokens.forEach((token, index) => {
    assert.deepEqual(findViolations({ text: token }), [{ kind: 'secret', detail: `${names[index]} at line 1` }], token);
  });
});

test('public Firebase API keys and ordinary words are not secrets', () => {
  assert.deepEqual(kindsIn('apiKey: "AIzaSyD-EXAMPLEexampleEXAMPLEexample12"'), []);
  assert.deepEqual(kindsIn('ask-the-owner and risk-free tasks; BEGIN PUBLIC KEY'), []);
  assert.deepEqual(kindsIn('see docs/sk-maintenance-window-for-the-catalog-pipeline.md'), []);
});

test('a Co-Authored-By trailer in a commit message is rejected, in any case', () => {
  const message = 'feat: add thing\n\nBody text.\n\nco-authored-by: Someone <someone@example.com>\n';
  assert.deepEqual(findViolations({ text: message }), [{ kind: 'trailer', detail: 'Co-Authored-By trailer at line 5' }]);
  assert.deepEqual(kindsIn('CO-AUTHORED-BY: X <x@example.com>'), ['trailer']);
});

test('mentioning the trailer mid-sentence is not a trailer', () => {
  assert.deepEqual(kindsIn('docs: explain why Co-Authored-By: lines are refused'), []);
});

const STAGED_DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  'index 1111111..2222222 100644',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -3 +3 @@ export const config = {',
  '-  host: "example-secret-host",',
  '+  host: "localhost",',
  '@@ -10,0 +11,2 @@ export const config = {',
  '+  // fine',
  '+  backup: "EXAMPLE-SECRET-HOST",',
  'diff --git a/keys/id b/keys/id',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/keys/id',
  '@@ -0,0 +1 @@',
  `+${keyHeader('OPENSSH PRIVATE KEY')}`,
  '\\ No newline at end of file',
  '',
].join('\n');

test('in a staged diff only added lines are scanned, reported by file and line', () => {
  assert.deepEqual(findViolations({ text: STAGED_DIFF, denylist: ['example-secret-host'], format: 'diff' }), [
    { kind: 'denylisted', detail: 'src/config.ts:12' },
    { kind: 'secret', detail: 'private key header at keys/id:1' },
  ]);
});

test('a trailer-shaped line inside a staged file is content, not a trailer', () => {
  const diff = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -0,0 +1 @@', '+Co-Authored-By: example', ''].join('\n');
  assert.deepEqual(findViolations({ text: diff, format: 'diff' }), []);
});

const scanDiff = (lines) =>
  findViolations({ text: [...lines, ''].join('\n'), denylist: ['example-secret-host'], format: 'diff' });

test('an added line that starts with "++ " is content, not a file header', () => {
  assert.deepEqual(
    scanDiff(['diff --git a/n.txt b/n.txt', '--- a/n.txt', '+++ b/n.txt', '@@ -1,0 +2 @@', '+++ example-secret-host']),
    [{ kind: 'denylisted', detail: 'n.txt:2' }],
  );
});

test('a denylisted file path is flagged and withheld from every report line', () => {
  assert.deepEqual(
    scanDiff([
      'diff --git a/notes/example-secret-host.md b/notes/example-secret-host.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/notes/example-secret-host.md',
      '@@ -0,0 +1 @@',
      `+${keyHeader('PRIVATE KEY')}`,
    ]),
    [
      { kind: 'denylisted', detail: 'staged file path (withheld)' },
      { kind: 'secret', detail: 'private key header at (withheld path):1' },
    ],
  );
});

test('a binary file with a denylisted path is flagged', () => {
  assert.deepEqual(
    scanDiff([
      'diff --git a/img/example-secret-host.png b/img/example-secret-host.png',
      'new file mode 100644',
      'Binary files /dev/null and b/img/example-secret-host.png differ',
    ]),
    [{ kind: 'denylisted', detail: 'staged file path (withheld)' }],
  );
});

test('deleting a file with a denylisted path is allowed', () => {
  assert.deepEqual(
    scanDiff([
      'diff --git a/old/example-secret-host.txt b/old/example-secret-host.txt',
      'deleted file mode 100644',
      '--- a/old/example-secret-host.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
    ]),
    [],
  );
});

test('the denylist ignores comments and blank lines', () => {
  const { denylist } = resolveDenylist({ fileText: '# private hosts\n\n  example-secret-host  \nexample-other\\.test\n' });
  assert.deepEqual(denylist, ['example-secret-host', 'example-other\\.test']);
});

test('a leading (?i) flag, as written for grep and secret scanners, is accepted and matching stays case-insensitive', () => {
  const { denylist } = resolveDenylist({ fileText: '(?i)example-secret\\.host\n' });
  assert.deepEqual(denylist, ['example-secret\\.host']);
  const violations = findViolations({ text: 'see EXAMPLE-SECRET.HOST', denylist });
  assert.deepEqual(violations.map((v) => v.kind), ['denylisted']);
});

test('the env var takes precedence over the local file', () => {
  const { denylist } = resolveDenylist({ envValue: 'example-from-env\n', fileText: 'example-from-file' });
  assert.deepEqual(denylist, ['example-from-env']);
});

test('locally, a missing denylist skips denylist checks with a warning', () => {
  const { denylist, warning } = resolveDenylist({});
  assert.deepEqual(denylist, []);
  assert.match(warning, /denylist checks skipped/);
});

test('in CI, an empty denylist env var fails even if a file exists', () => {
  assert.throws(() => resolveDenylist({ ci: true, envValue: '', fileText: 'example-secret-host' }), /HYGIENE_DENYLIST/);
});

test('an invalid denylist regex is reported by line number without echoing the entry', () => {
  assert.throws(
    () => resolveDenylist({ fileText: '# c\nexample-ok\nexample-(broken\n' }),
    (error) => /line 3/.test(error.message) && !error.message.includes('broken'),
  );
});

test('in CI, a denylist env var holding only comments fails', () => {
  assert.throws(() => resolveDenylist({ ci: true, envValue: '# nothing here\n\n' }), /HYGIENE_DENYLIST/);
});

test('an unknown input format is refused rather than guessed', () => {
  assert.throws(() => findViolations({ text: 'x', format: 'diffs' }), /format/);
});

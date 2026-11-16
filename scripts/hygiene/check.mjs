import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_EMAILS = ['49572768+Memoriuhl@users.noreply.github.com'];

const SECRET_SHAPES = [
  { name: 'private key header', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/ },
  { name: 'GitHub token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: 'AWS access key id', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', pattern: /\bxox[bap]-[A-Za-z0-9-]{10,}/ },
  { name: 'secret key', pattern: /\bsk-(?:[A-Za-z0-9_]+-)*[A-Za-z0-9_]{20,}/ },
];

const TRAILER = /^\s*co-authored-by\s*:/i;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDenylist(source, label) {
  const entries = [];
  source.split('\n').forEach((raw, index) => {
    const entry = raw.trim().replace(/^\(\?i\)/, '');
    if (entry === '' || raw.trim().startsWith('#')) return;
    try {
      new RegExp(entry, 'i');
    } catch {
      throw new Error(`${label} line ${index + 1} is not a valid regular expression`);
    }
    entries.push(entry);
  });
  return entries;
}

export function resolveDenylist({ envValue = '', fileText = null, ci = false } = {}) {
  const fromEnv = parseDenylist(envValue, 'HYGIENE_DENYLIST');
  if (fromEnv.length > 0) return { denylist: fromEnv };
  if (ci) throw new Error('HYGIENE_DENYLIST has no entries; CI refuses to run without the denylist');
  const denylist = fileText === null ? [] : parseDenylist(fileText, '.hygiene-denylist');
  if (denylist.length === 0) {
    return { denylist, warning: 'no .hygiene-denylist or HYGIENE_DENYLIST found; denylist checks skipped' };
  }
  return { denylist };
}

function messageLines(text) {
  return text.split('\n').map((content, index) => ({ where: `line ${index + 1}`, content }));
}

function pathFromDiffHeader(rest) {
  const half = (rest.length - 5) / 2;
  const path = rest.slice(2, 2 + half);
  return rest === `a/${path} b/${path}` ? path : rest;
}

function parseStagedDiff(diff) {
  const files = [];
  let file = null;
  let inHunk = false;
  let nextLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = { path: pathFromDiffHeader(raw.slice('diff --git '.length)), deleted: false, added: [] };
      files.push(file);
      inHunk = false;
    } else if (file === null) {
      continue;
    } else if (HUNK_HEADER.test(raw)) {
      inHunk = true;
      nextLine = Number(raw.match(HUNK_HEADER)[1]);
    } else if (inHunk) {
      if (raw.startsWith('+')) {
        file.added.push({ line: nextLine, content: raw.slice(1) });
        nextLine += 1;
      }
    } else if (raw.startsWith('deleted file mode')) {
      file.deleted = true;
    } else if (raw.startsWith('+++ b/')) {
      file.path = raw.slice('+++ b/'.length);
    }
  }
  return files;
}

export function findViolations({ authorEmails = [], text = '', denylist = [], format = 'message' } = {}) {
  if (format !== 'message' && format !== 'diff') throw new Error(`unknown format: ${format}`);
  const patterns = denylist.map((source) => new RegExp(source, 'i'));
  const isMessage = format === 'message';
  const emailViolations = authorEmails
    .filter((email) => !ALLOWED_EMAILS.includes(email))
    .map(() => ({ kind: 'email', detail: `identity email is not ${ALLOWED_EMAILS.join(' or ')}` }));
  const matchesDenylist = (value) => patterns.some((pattern) => pattern.test(value));
  const pathViolations = [];
  let lines;
  if (isMessage) {
    lines = messageLines(text);
  } else {
    lines = parseStagedDiff(text).flatMap(({ path, deleted, added }) => {
      if (deleted) return [];
      const withheld = matchesDenylist(path);
      if (withheld) pathViolations.push({ kind: 'denylisted', detail: 'staged file path (withheld)' });
      const shownPath = withheld ? '(withheld path)' : path;
      return added.map(({ line, content }) => ({ where: `${shownPath}:${line}`, content }));
    });
  }
  const textViolations = lines.flatMap(({ where, content }) => {
    const found = [];
    if (matchesDenylist(content)) {
      found.push({ kind: 'denylisted', detail: where });
    }
    if (isMessage && TRAILER.test(content)) {
      found.push({ kind: 'trailer', detail: `Co-Authored-By trailer at ${where}` });
    }
    for (const { name, pattern } of SECRET_SHAPES) {
      if (pattern.test(content)) found.push({ kind: 'secret', detail: `${name} at ${where}` });
    }
    return found;
  });
  return [...emailViolations, ...pathViolations, ...textViolations];
}

const SCISSORS = /^# -+ >8 -+$/m;
const COMMENT_LINE = /^#.*$/gm;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function emailFromIdent(ident) {
  return ident.match(/<([^>]*)>/)?.[1] ?? '';
}

function findDenylistFile() {
  const worktreeRoot = git(['rev-parse', '--show-toplevel']).trim();
  const mainCheckoutRoot = dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  return [worktreeRoot, mainCheckoutRoot]
    .map((root) => join(root, '.hygiene-denylist'))
    .find((path) => existsSync(path));
}

function isCi() {
  return !['', '0', 'false'].includes((process.env.CI ?? '').trim().toLowerCase());
}

function loadDenylist() {
  const denylistFile = findDenylistFile();
  return resolveDenylist({
    envValue: process.env.HYGIENE_DENYLIST ?? '',
    fileText: denylistFile ? readFileSync(denylistFile, 'utf8') : null,
    ci: isCi(),
  });
}

function checkStaged(denylist) {
  const authorEmails = ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map((name) => emailFromIdent(git(['var', name])));
  const text = git(['-c', 'core.quotePath=false', 'diff', '--cached', '--no-renames', '--no-color', '--no-ext-diff', '-U0']);
  return findViolations({ authorEmails, text, denylist, format: 'diff' });
}

function checkMessage(denylist, messageFile) {
  const text = readFileSync(messageFile, 'utf8').split(SCISSORS)[0].replace(COMMENT_LINE, '');
  return findViolations({ text, denylist }).map((v) => ({ ...v, detail: `commit message ${v.detail}` }));
}

function runCli([mode, messageFile]) {
  if (mode !== 'pre-commit' && !(mode === 'commit-msg' && messageFile)) {
    console.error('usage: check.mjs pre-commit | commit-msg <message-file>');
    return 2;
  }
  let violations;
  try {
    const { denylist, warning } = loadDenylist();
    if (warning) console.error(`hygiene: warning: ${warning}`);
    violations = mode === 'pre-commit' ? checkStaged(denylist) : checkMessage(denylist, messageFile);
  } catch (error) {
    console.error(`hygiene: ${error.message}`);
    return 1;
  }
  for (const { kind, detail } of violations) console.error(`hygiene: ${kind}: ${detail}`);
  if (violations.length > 0) console.error(`hygiene: ${mode} refused (${violations.length} problem(s))`);
  return violations.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = runCli(process.argv.slice(2));

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_EMAILS = ['49572768+Memoriuhl@users.noreply.github.com'];
const ALLOWED_COMMITTER_EMAILS = [...ALLOWED_EMAILS, 'noreply@github.com'];

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

function hasPrivateAddress(text) {
  const candidates = text.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\d|\.\d)/g);
  for (const [candidate] of candidates) {
    const octets = candidate.split('.').map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    const [first, second] = octets;
    if (first === 10 || (first === 100 && second >= 64 && second <= 127) ||
        (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return true;
  }
  return false;
}

export function findViolations({ authorEmails = [], committerEmails = [], text = '', denylist = [], format = 'message' } = {}) {
  if (format !== 'message' && format !== 'diff') throw new Error(`unknown format: ${format}`);
  const patterns = denylist.map((source) => new RegExp(source, 'i'));
  const isMessage = format === 'message';
  const emailViolations = [
    ...authorEmails.filter((email) => !ALLOWED_EMAILS.includes(email))
      .map(() => ({ kind: 'email', detail: 'author identity is not allowed' })),
    ...committerEmails.filter((email) => !ALLOWED_COMMITTER_EMAILS.includes(email))
      .map(() => ({ kind: 'email', detail: 'committer identity is not allowed' })),
  ];
  const matchesDenylist = (value) => patterns.some((pattern) => pattern.test(value));
  const pathViolations = [];
  let lines;
  if (isMessage) {
    lines = messageLines(text);
  } else {
    lines = parseStagedDiff(text).flatMap(({ path, deleted, added }) => {
      if (deleted) return [];
      const denylisted = matchesDenylist(path);
      const address = hasPrivateAddress(path);
      const withheld = denylisted || address;
      if (denylisted) pathViolations.push({ kind: 'denylisted', detail: 'staged file path (withheld)' });
      if (address) pathViolations.push({ kind: 'address', detail: 'staged file path (withheld)' });
      const shownPath = withheld ? '(withheld path)' : path;
      return added.map(({ line, content }) => ({ where: `${shownPath}:${line}`, content }));
    });
  }
  const textViolations = lines.flatMap(({ where, content }) => {
    const found = [];
    if (matchesDenylist(content)) {
      found.push({ kind: 'denylisted', detail: where });
    }
    if (hasPrivateAddress(content)) found.push({ kind: 'address', detail: where });
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
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('git operation failed; verify repository and commit references');
  }
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
  const authorEmails = [emailFromIdent(git(['var', 'GIT_AUTHOR_IDENT']))];
  const committerEmails = [emailFromIdent(git(['var', 'GIT_COMMITTER_IDENT']))];
  const text = git(['-c', 'core.quotePath=false', 'diff', '--cached', '--no-renames', '--no-color', '--no-ext-diff', '-U0']);
  return findViolations({ authorEmails, committerEmails, text, denylist, format: 'diff' });
}

function checkMessage(denylist, messageFile) {
  const text = readFileSync(messageFile, 'utf8').split(SCISSORS)[0].replace(COMMENT_LINE, '');
  return findViolations({ text, denylist }).map((v) => ({ ...v, detail: `commit message ${v.detail}` }));
}

function checkRange(denylist, base, head) {
  const resolve = (ref) => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const end = resolve(head);
  const range = /^0{40}$/.test(base) ? end : `${resolve(base)}..${end}`;
  const commits = git(['rev-list', '--reverse', range, '--']).trim().split('\n').filter(Boolean);
  return commits.flatMap((commit) => {
    const [author, committer, ...message] = git(['show', '-s', '--format=%ae%n%ce%n%B', commit]).split('\n');
    const metadata = findViolations({ authorEmails: [author], committerEmails: [committer], text: message.join('\n'), denylist })
      .map((v) => ({ ...v, detail: `commit message ${v.detail}` }));
    const text = git(['-c', 'core.quotePath=false', 'show', '--format=', '--root', '--diff-merges=first-parent',
      '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', commit, '--']);
    return [...metadata, ...findViolations({ text, denylist, format: 'diff' })]
      .map((v) => ({ ...v, detail: `${commit.slice(0, 12)} ${v.detail}` }));
  });
}

function checkPullRequest(denylist) {
  return [['title', process.env.PR_TITLE], ['body', process.env.PR_BODY]].flatMap(([field, text]) =>
    findViolations({ text: text ?? '', denylist }).map((v) => ({ ...v, detail: `pull request ${field} ${v.detail}` })));
}

function runCli([mode, messageFile, head, ...extra]) {
  if (extra.length || !((['pre-commit', 'pull-request'].includes(mode) && !messageFile) ||
      (mode === 'commit-msg' && messageFile && !head) || (mode === 'range' && messageFile && head))) {
    console.error('usage: check.mjs pre-commit | commit-msg <message-file> | range <base> <head> | pull-request');
    return 2;
  }
  let violations;
  try {
    const { denylist, warning } = loadDenylist();
    if (warning) console.error(`hygiene: warning: ${warning}`);
    violations = mode === 'pull-request' ? checkPullRequest(denylist)
      : mode === 'range' ? checkRange(denylist, messageFile, head)
      : mode === 'pre-commit' ? checkStaged(denylist) : checkMessage(denylist, messageFile);
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

# plate-curator-vercel

A review dashboard for the Plate Curator catalog, deployed on Vercel. The design is in [docs/spec.md](docs/spec.md).

## Before your first commit

Turn on the repository's commit hooks. They refuse commits with a foreign author or committer email, secrets, private strings or `Co-Authored-By` trailers:

```sh
git config core.hooksPath .githooks
```

Commit with the GitHub no-reply identity, set for this repository only:

```sh
git config user.name "Jonathan Best"
git config user.email "49572768+Memoriuhl@users.noreply.github.com"
```

The private-string list lives in a gitignored `.hygiene-denylist` file (one case-insensitive regular expression per line), supplied privately by the owner. Without it the hooks still check emails, secrets and trailers, and warn that the denylist was skipped. When `CI` is set, the list must come from the `HYGIENE_DENYLIST` environment variable (newline-separated), and the check fails if it is empty.

Run the hook tests with `node --test scripts/hygiene/`.

## Continuous hygiene checks

Every pull request and push to `main` or `release` runs the tests on Node 24, then checks each commit in the event's range. Author and committer emails, commit messages, added lines and file paths are checked, including violations removed by a later commit. Merge commits are compared to their first parent; commits on merged branches are also checked.

Run the same range check locally with `node scripts/hygiene/check.mjs range <base> <head>`. The base is excluded and the head is included. An all-zero base (a newly created branch's push event) checks all history reachable from the head. CI requires a nonempty `HYGIENE_DENYLIST` repository secret; fork pull requests without access to it fail closed. Reports identify violation kinds and locations without printing matched text, and denylisted paths are withheld.

A separate job runs gitleaks 8.30.1 against the same range, using a download verified against its pinned SHA-256 checksum. `.gitleaks.toml` extends the default rules and allows public Firebase web API identifiers only under the Google API key rule. Scanner output is kept out of the job log; a failure can be investigated locally using the same version and range. All Actions are pinned to full commit hashes and the workflow has read-only repository permissions.

Required branch protection starts at public handoff; while the repository is private, review both checks before merging.

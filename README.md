# plate-curator-vercel

A review dashboard for the Plate Curator catalog, deployed on Vercel. The design is in [docs/spec.md](docs/spec.md).

Publish operators and deployment maintainers should use [Publish controls and recovery](docs/publish-recovery.md)
for command identity and takeover, receipt ownership and adoption, abandonment and
version burns, Members tombstones and authority markers, fencing older approval
Workflows before Resume, and rollback requirements. Keep those operational rules
in that guide; link to them from other deployment documentation.

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

Run the hook tests with `node --test scripts/hygiene/*.test.mjs`.

## Continuous hygiene checks

Every pull request and push to `main` or `release` runs the tests on Node 24, then checks each commit in the event's range. Author and committer emails, commit messages, added lines and file paths are checked, including violations removed by a later commit. Merge commits are compared to their first parent; commits on merged branches are also checked.

Authors must use the repository's no-reply identity. Committers may also use `noreply@github.com` so GitHub merge and squash commits pass. Private and Tailscale IPv4 addresses are rejected in added lines, paths and messages; address-bearing paths are withheld from diagnostics. Use localhost or the dev server in documentation.

Pull request titles and bodies use the same message checks, including address detection, on opening, editing, reopening and new commits. CI passes both fields through environment variables to `node scripts/hygiene/check.mjs pull-request`.

Run the same range check locally with `node scripts/hygiene/check.mjs range <base> <head>`. The base is excluded and the head is included. An all-zero base (a newly created branch's push event) checks all history reachable from the head. CI requires a nonempty `HYGIENE_DENYLIST` repository secret; fork pull requests without access to it fail closed. Reports identify violation kinds and locations without printing matched text, and denylisted paths are withheld.

A separate job runs gitleaks 8.30.1 against the same range, using a download verified against its pinned SHA-256 checksum. `.gitleaks.toml` extends the default rules and allows public Firebase web API identifiers only under the Google API key rule. Scanner output is kept out of the job log; a failure can be investigated locally using the same version and range. All Actions are pinned to full commit hashes and the workflow has read-only repository permissions.

Required branch protection starts at public handoff; while the repository is private, review both checks before merging.

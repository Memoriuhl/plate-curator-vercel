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

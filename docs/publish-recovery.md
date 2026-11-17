# Stale Publish recovery (#119)

A fresh Publish reads `config/catalog` under the Publish lease. If its version
is different from the approved Batch's `baselineVersion`, it returns
`stale_baseline` with `reviewedVersion` and `liveVersion`. It releases the lease
and reservation without creating a receipt or snapshot, moving the pointer, or
changing the approved Batch. An unrelated release uses the same rule.

The Owner-only authenticated Publish GET and POST preflight explain an already
stale Batch. The Workflow step repeats the authoritative check, so a release
between command acceptance and execution returns the same versions through the
run result. A pointer that moves during an attempt remains `pointer_moved`.

A durable receipt keeps its original release identity, checksum and conditional
pointer reconciliation. Upload and committed-pointer response loss still recover
the same version. An uncommitted legacy receipt whose `fromVersion` differs from
the approved baseline returns `receipt_baseline_conflict`, preserving the receipt
for triage and releasing the reservation. A committed legacy receipt may finish
curator order and Batch bookkeeping. Never delete a committed receipt or retry
it as a fresh release.

If a legacy `receipt_baseline_conflict` has already uploaded a blob at
`fromVersion + 1`, publishing a fresh copy on that same Catalog head will hit
`version_taken`. Clearing that orphaned Snapshot belongs to Snapshot abandonment
[#129](https://github.com/Memoriuhl/plate-curator-vercel/issues/129). Until that
recovery is available, triage leaves both the pointer and the blob untouched.

The Owner can select **Copy to new Batch** in Publish. POST
`/api/batches/:id/copy` accepts the source revision and explicit target Catalog
version; the environment comes from the server. The target identity is derived
from environment, source ID, source revision and target version. Repeated requests,
including an ambiguous response or concurrent Owners, return the same copy.
Replays return its current state; they never reset an edited or approved copy.

The transaction checks the source environment, approved state and exact revision,
rejects an outstanding Publish reservation or committed receipt, and checks the
Catalog head before creating the entire new Batch, edits and initial live revision
signal. A head race returns `head_moved` and the latest version. The UI requires
another explicit click to copy against that version. A new version gets a separate
copy; no existing copy is silently retargeted.

The new open Batch belongs to the acting Owner, starts at revision zero with no
approval or Publish/Workflow metadata, and links to its source revision. Proposed
editable fields (including explicit null clears) are retained. Edit revisions and
before values use the new immutable snapshot; State order before values use that
snapshot's ordering. Missing referenced Plates or Variant parents and incompatible
Jurisdiction inventories are reported with no partial target. The original Batch,
its edits, approval and run history remain intact. Normal Submit, Approve and
Publish are required for the copy. Copy does not start a model or Publish run.

## Deployment compatibility and release gate

Existing approval Workflow runs can continue on the deployment that started them.
Updating routes or promoting a deployment does not retrofit the new guard into
those older steps. New route preflight alone is insufficient: an already accepted
command can execute the older publisher.

Before relying on this guard for a release, inventory waiting and executing
approval runs by Batch, revision and deployment. Let already committed attempts
finish bookkeeping from their receipts. Investigate uncommitted legacy mismatches
without advancing their pointers. Supersede waiting pre-fix approval runs through
the normal review edit/resubmit flow, then Submit and Approve again on the fixed
deployment; for a stale baseline, use the new copy flow instead. Do not assume a
redeploy or a request sent to a new URL changes an old run's deployment. Verify
that no waiting pre-fix run can still receive a Publish command before proceeding.

A separately authorized staging check should start NEW approval runs on the fixed
deployment, using isolated data/environment: exercise the authenticated stale
preflight, a Catalog-head race after command acceptance, run-result versions, copy
and review navigation, and refusal to Publish an unapproved copy. Also confirm
receipt reconciliation on that deployment. Such a check must not use the shared
public Catalog as disposable data. This implementation performs no deployment,
Catalog publication, or production Firebase access. Hosted Workflow execution and
old-run drainage remain release integration gates, not claims of local coverage.

## Local verification

Focused behavior: `npx vitest run tests/publish tests/review/copy.test.ts tests/review/copy-route.test.ts tests/review/approval-route.test.ts tests/review/approval-workflow.test.ts tests/publish-recovery.test.tsx tests/review-recovery-navigation.test.tsx tests/publish-ui.test.tsx tests/review-ui.test.tsx`.

Transactions/concurrency: `npm run test:emulator` uses only Firestore at localhost
and project `demo-plate-curator`. Snapshot storage in Publish tests is in memory.
The suite checks copy atomicity, concurrent retries, source/head/environment races,
initial live signals, and Publish reservation and receipt behavior. The screen
tests exercise both preflight and Workflow failures, recovery navigation, affected
items, and explicit retry after a head race. Run `npm run typecheck`,
`npm run lint` and `npm test` for broader coverage. Hosted tagging is out of scope.

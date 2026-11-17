# Publish controls and recovery (#126, #119)

## Pause and Resume

Active Owners use the Catalog publishing control in Publish to Pause or Resume.
The screen shows the last actor and time. Editors cannot change the control.
Draft edits, Submit and Approve continue while publishing is paused. Existing
deployment restrictions still apply to changing the control and requesting Publish.

`config/publishControl` sits beside `config/catalog`, shared by every deployment
targeting that Catalog, independently of the dashboard environment key. Every
Pause and every Resume transaction increments its generation and records the
Owner's UID, email and timestamp. Missing or malformed control data fails closed:
no new command or pointer advance is allowed. An active Owner's first Resume
creates a missing control at generation 1. Malformed existing data needs triage.

Each accepted Publish has a distinct command ID and carries its accepted
generation into the Workflow and immutable release receipt. The command shape
can gain a requester authority marker alongside the generation without changing
existing receipts. Requester revocation enforcement belongs to #127.

Firestore decides the race at the pointer commit. The transaction reads the
shared control alongside the lease, Batch, receipt and pointer. If Pause commits
first, the command stops without advancing the pointer. A quick Pause and Resume
changes the generation, so the old command is superseded even when publishing is
enabled again. Missing control also stops the command. Terminal reasons persist
in `publishCommandStops` by command ID, so step retries reproduce the same stop.
The lease and reservation are released, the Batch stays approved with its history,
and an uploaded but uncommitted Snapshot and receipt remain intact.

If Publish committed first, its receipt wins: retries finish the bookkeeping and
report the same published version even after Pause or a generation change. They
never advance the pointer a second time or replace that outcome with a stop.
Pause does not roll back a published Catalog.

Resume only permits new requests. It never restarts a stopped Workflow. Publishing
a stopped Batch requires an explicit fresh Publish command under the current
generation. The dedicated retry UI and prepared Snapshot reuse are tracked in
#128; Snapshot abandonment remains #129. Until those recovery paths are available,
keep stopped receipts and Snapshots for triage rather than deleting or restarting
their commands.

## Known gap until #128/#129

A stop after upload but before the pointer commit leaves an uploaded receipt
bound to the stopped command. A fresh click on the same Batch then reports
`paused`, and any other Batch attempting to take that Snapshot version hits
`version_taken`. The Catalog stays on its old version: this is fail-safe, but it
blocks further publishing. Recovery comes with explicit retry (#128) and Snapshot
abandonment (#129). Until those paths ship, preserve the receipt and uploaded
Snapshot for triage.

## Stale baseline

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

Before relying on Pause, inventory and drain older waiting or executing approval
Workflows as well. They run their original deployment's code and carry no
publication generation. Allow already committed receipts to finish bookkeeping.
Supersede uncommitted waiting runs through the normal edit/resubmit flow, then
Submit and Approve again on this deployment (or copy stale proposals for fresh
review). Verify that no older waiting run can receive Publish. A route update or
Resume alone does not retrofit this protection into those runs. Commands without
a generation that reach the new publisher are treated as superseded once the
control document exists; they never adopt the current generation. Missing control
also fails closed. Hosted verification must use newly started runs before the
control is relied on for a release.

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

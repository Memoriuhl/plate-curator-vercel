# Publish controls and recovery (#128, #127, #126, #119)

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
also binds the authenticated requester as requestedBy: UID, normalized member
email and authorityEpoch. Existing member documents without an epoch start at
zero. Members role changes, removal and restoration increment the epoch in the
same transaction as the authority change. Removal retains an internal tombstone
with status `removed` and the incremented epoch while hiding the member from
lookups and lists and cleaning up curatorLiveAccess. Recreating a removed member advances that epoch
again; old commands cannot regain authority. Commands without a bound marker
are superseded. A bootstrap UID still needs an active Owner member document.

Firestore decides the race at the pointer commit. The transaction reads the
shared control and requester member alongside the lease, Batch, receipt and
pointer. If Pause commits first, the command stops without advancing the pointer. If requester demotion or
removal commits first, the command stops as revoked. An epoch mismatch also
revokes an old command after Owner access is restored. Revoking a different
approver preserves approval and does not stop the active requester. A quick
Pause and Resume changes the generation, so the old command is superseded even when publishing is
enabled again. Missing control also stops the command. Terminal reasons persist
in `publishCommandStops` by command ID, so step retries reproduce the same stop
even if pause and revocation affect the same command. The workspace identifies
the requester and revoked stop, states that the Catalog did not advance, and requires a fresh
Publish by an active Owner. Revocation remains in Members.
The lease and reservation are released, the Batch stays approved with its history,
and an uploaded but uncommitted Snapshot and receipt remain intact.

If Publish committed first, its receipt wins: retries finish the bookkeeping and
report the same published version even after Pause, a generation change or
requester revocation. They never advance the pointer a second time or replace that outcome with a stop.
Pause does not roll back a published Catalog.

Resume only permits new requests. It never restarts a stopped Workflow. Publishing
a stopped Batch requires an explicit fresh Publish command under the current
generation and requester authority marker. Restoring Owner access also leaves old
commands stopped.

## Explicit retry of the same Batch

Inspect the stopped outcome in Publish: its reason and requester identify the
command, and “The Catalog did not advance” confirms that the old version stayed
live. Resume publishing if paused. An active Owner can then select **Publish
again** for the same approved revision. A different active Owner can request it
after the original requester was revoked. Editors cannot request it. If the live
Catalog changed, use **Copy to new Batch** for fresh review instead.

Each explicit click supplies a fresh command ID. A genuinely waiting approval run
still receives its Publish hook; a stopped run has ended, so the retry starts a
dedicated durable Publish run. Acceptance stores the requester and current
generation transactionally with approval, revision and baseline checks. A retained
start-hook token prevents concurrent starts for one command ID; the durable command
record returns the same run on subsequent requests, including after completion.
Retries do not create another release or silently change requester identity.

Under the Publish lease, the fresh command checks the existing immutable Snapshot
checksum. One Firestore transaction checks the approved revision, live pointer,
lease, current requester/control and the previous command’s durable stop before
rebinding the uncommitted receipt. The receipt retains its version and checksum and
appends the prior command identity to `supersededCommands`. Missing or mismatched
bytes return `version_taken` for triage; nothing is re-uploaded over them. A moved
baseline offers Copy. Old work cannot save or commit the adopted receipt and
returns `superseded`. Only the committed command reaches the existing per-version
Catalog push claim.

## Known gap until #129

Another Batch attempting to take a stopped attempt’s retained Snapshot version
still hits `version_taken`. Snapshot abandonment and publishing a different Batch
over that unused version remain #129. Preserve the receipt and Snapshot for triage;
do not delete them manually. Same-Batch explicit retry does not abandon an object.

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

Members changes must only be made from deployments that include this change.
Older deployments neither increment authorityEpoch nor understand tombstones.
Demoting and restoring an Owner through old code leaves the epoch unchanged, so
an old command can match again. A hard delete followed by re-invitation can also
realign an epoch with an older command. Restrict Members writes to the fixed
deployments before relying on requester revocation. Tombstones use status
`removed` so older active-Owner and activation checks treat them as inactive,
but this does not make old mutation paths safe.

Never hard-delete member documents, including through the console or scripts.
Removal must retain the member tombstone and its authority epoch through the
Members store paths. Re-invitation and restoration must retain and advance that
history rather than resetting it.

Existing approval Workflow runs can continue on the deployment that started them.
Updating routes or promoting a deployment does not retrofit the new guard into
those older steps. New route preflight alone is insufficient: an already accepted
command can execute the older publisher.

Before Resume, inventory older waiting or executing approval Workflows by Batch,
revision and starting deployment. Runs are pinned to their starting deployment:
older code never reads the publication control. Creating the control document
does not supersede or stop those older runs. Fence their uncommitted Batches by
moving them out of `approved` through the normal review edit flow before Resume.
Verify the authoritative Batch state and that no older run can advance a pointer.
Already committed receipts must finish bookkeeping instead of being fenced as
uncommitted work. An in-flight pointer commit still determines which outcome won.

After fencing older runs, Submit and Approve again on the fixed deployment (or
copy stale proposals for fresh review). A redeploy, new route URL or Resume does
not change the code of an old run. Only commands reaching the new publisher are
checked for a missing generation or requester authority marker and treated as superseded when the control
exists; this does not protect runs executing older publisher code. Hosted proof
with newly started runs and the legacy-run fence are release gates before relying
on Pause or requester revocation.

Before relying on this guard for a release, inventory waiting and executing
approval runs by Batch, revision and deployment. Let already committed attempts
finish bookkeeping from their receipts. Investigate uncommitted legacy mismatches
without advancing their pointers. Fence waiting pre-fix approval runs by moving
their Batches out of `approved` before Resume, then Submit and Approve on the fixed
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

# Publish controls and recovery (#129, #128, #127, #126, #119)

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
The lease and Batch reservation are released, the Batch stays approved with its history,
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
The client keeps that ID after a lost response or service error until an accepted
or terminal answer. A replay locates the retained start token and binds its run;
if no run exists, it repeats the control, approval and baseline checks before
starting. Retries do not create another release or silently change requester identity.

Preflight and acceptance use the same server eligibility predicate. Publish again
is driven by its `canRetry` result, including a locked response while a live run
owns the claim. A fresh click can replace a claim with a durable stop, a bound run
that is completed, failed or cancelled, or an unbound claim older than two minutes.
Before applying the TTL, the server looks up the deterministic start token. If a
live run exists, it binds that run to the claim and keeps the claim locked; TTL
takeover requires an affirmative lookup showing no run. Unknown lookup state
fails closed. A delayed start response cannot bind once its claim was replaced.
`GET /api/batches/:id/publish` may idempotently write the recovered run binding
and its Batch metadata while computing eligibility. It does not start a run or
advance the Batch revision. A missing claim document is treated as expired and
unbound, then checked through its deterministic token before takeover. An explicit
Workflow run-not-found result permits takeover after the claim TTL; transient or
unknown lookup errors stay locked and are retried on the next request.
The clock is supplied to the check. Replacement writes a durable superseded stop
for a command without one in the same acceptance transaction. A live bound run
stays locked even after two minutes. After a failed start, retry the same intent,
or wait for the unbound claim to expire before submitting a fresh click.

Under the Publish lease, the fresh command checks the existing immutable Snapshot
checksum. One Firestore transaction checks the approved revision, live pointer,
lease, current requester/control and the previous command’s durable stop before
rebinding the uncommitted receipt. The receipt retains its version and checksum and
appends the prior command identity to `supersededCommands`. If upload never happened,
it recomputes bytes for the same revision and from-version and permits create-only
upload only when their checksum matches the receipt. Mismatched bytes return
`version_taken` for triage; nothing is uploaded over different bytes. A moved
baseline offers Copy. Old work cannot save or commit the adopted receipt and
returns `superseded`. Only the committed command reaches the existing per-version
Catalog push claim.

Immediately before create-only upload, another lease-guarded transaction checks
receipt ownership, exact Batch/revision, reserved unburned target, current pointer,
approval, authority, checksum and the absence of any committed receipt for the
target version. A competing object can only make create-only return exists; its
checksum must still match, and different bytes are never overwritten. Superseding
a claim and recording its stop are one transaction; an aborted replacement leaves
both the old claim and its prior stop history intact. Old work observes superseded
at its first check after takeover, including before receipt adoption.
Before an uncommitted pointer advance, the publisher refreshes the object's current
download URL. Recreated matching bytes can have a new download token; a lost
metadata response must not leave a retry using the old object's URL.
The URL, storage generation, metageneration and md5Hash/crc32c come from one
[GCS object metadata response](https://docs.cloud.google.com/storage/docs/json_api/v1/objects).
The receipt stores that object identity separately from the publication-control
generation. SHA256 verification downloads the exact selected storage generation.
Inside the pointer transaction, after reading the lease, authority and receipt,
the commit path checks current object metadata and the generation-selected bytes,
then reads metadata again. A different generation, token, metageneration or hash
returns `version_taken` without advancing the pointer, even when the bytes are
identical. A recreation before metadata capture may instead refresh the receipt
to the verified current generation and its current token.

## Abandon a prepared Snapshot

An active Owner selects **Abandon prepared Snapshot** in Publish and supplies a
reason. This action is available while paused. It never advances the pointer.
Editors and unauthenticated requests are denied; the transaction rechecks the
Owner's member document and authority marker. A live command claim refuses
abandonment, even if the receipt still names an earlier stopped command. The
current claim must have a durable stop or satisfy the same terminal/confirmed
absent-run takeover rules as [explicit retry](#explicit-retry-of-the-same-batch).
Unknown or transient Workflow lookup results stay locked.

Under the Publish lease, one Firestore transaction verifies that the receipt is
uncommitted and its target is above the live pointer. No object or checksum proof
is required: a crash before upload can also be abandoned. The transaction archives
the receipt as `publishRecords/{batchId}@{revision}--{commandId}`, marks it
`abandoned`, stops every command bound to it (including the current Batch claim),
records the disposition on the Batch, and creates `publishVersionBurns/{version}`.
The audit records actor, time, reason, and the observed object identity tuple
(generation, metageneration, hashes and URL), or explicit `null` for no object.
Different or missing bytes do not prevent abandonment. Duplicate requests return
the original disposition; a failed transaction leaves all these records unchanged.
The original receipt key is freed only by this atomic archival operation, so a
fresh same-revision command recomputes bytes and receives a new receipt identity.
The archived attempt is never adopted.
Abandonment can also dispose of a stopped older receipt after its Batch has been
fenced out of approved; it does not require the Batch to remain publish-eligible.

Allocation chooses the smallest safe integer above the live pointer that is not
burned, held by any un-abandoned receipt, or targeted by any committed receipt in
any environment. Stopped receipts hold their versions until retry or abandonment.
The durable receipt reserves its target before upload; replay preserves that
target. With no excluded slots, allocation remains `pointer + 1`. Adoption proves
the receipt's reserved, unburned target and pointer at `fromVersion`, rather than
requiring adjacency. The blob's internal version always equals its target.

No Snapshot is deleted or overwritten. A delayed old create-only upload may still
land in the burned slot, but pointer advancement rejects burned targets and
abandoned receipts. Command stops also fence retries and late receipt writes.
Version gaps are safe for consumers: the game requires a newer pointer and a blob
whose internal version matches it; curator reads use committed versions. Never
reuse burned numbers. Generation-preconditioned garbage collection of unreferenced
objects is a separate follow-up, outside this recovery action.

Abandon before a fresh click permits a new attempt at the next available version.
A fresh click that owns a live run wins the opposite order: abandonment is refused
until that run stops. Committed receipts and targets at or below the pointer are
protected. The workspace reports refusal reasons and the final actor, time and
burned version.

## Operator recovery table

| Observed state | Owner action | Result |
| --- | --- | --- |
| Stopped, same approved revision, unchanged baseline | Resume if needed, then Publish again | Fresh authority; verifies and adopts the reserved receipt and bytes |
| Stopped, choose another Batch | Abandon prepared Snapshot, then publish the other eligible Batch | Old slot is burned; next receipt skips it; old commands stay stopped |
| Stopped before upload | Retry, or abandon with a reason | Missing object does not prevent recovery |
| Live run owns the current claim | Wait for the run to finish or stop | Retry and abandonment fail closed while it is live |
| Stale baseline | Copy to new Batch, review, Submit, Approve, Publish | New review against the current committed Snapshot |
| Committed pointer, incomplete bookkeeping | Retry the same command | Reconciles that version; never abandons or advances twice |
| Mismatched prepared bytes | Triage; abandon a stopped uncommitted attempt if it is no longer wanted | Audit records observed identity; committed data remains protected |
| Missing or malformed controls | Initialize with Resume if missing; investigate malformed data | No new pointer advance until authoritative controls are valid |

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

If a legacy `receipt_baseline_conflict` has an unused uploaded blob, stop its
command and use [abandonment](#abandon-a-prepared-snapshot) to record its disposition
and burn its target before proceeding with fresh review. Leave the blob untouched.

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

Never roll back to a deployment that ignores these controls while publishing is
possible. Pause and fence older deployment-pinned runs and their uncommitted
Batches first, using the procedure above. Pause alone cannot fence code that never
reads it. Dashboard rollback does not undo a committed Catalog release; Catalog
recovery publishes reviewed content as a higher, unburned version.

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
Run this suite alone. The claim-contention tests have scoped fifteen-second
budgets for Firestore transaction retries; the global test timeout is unchanged.
The suite checks copy atomicity, concurrent retries, source/head/environment races,
initial live signals, and Publish reservation and receipt behavior. The screen
tests exercise both preflight and Workflow failures, recovery navigation, affected
items, and explicit retry after a head race. Run `npm run typecheck`,
`npm run lint` and `npm test` for broader coverage. Hosted tagging is out of scope.

`tests-emulator/release-controls.test.ts` is the release-8 integration gate: stale
baseline plus Copy, pause before preparation/after upload/after commit, revocation
in both commit orders and revoke-restore fencing, two-Owner uploaded-receipt retry,
and abandonment followed by a different Batch. It runs the Publish Workflow with
emulator-backed receipts and push claims and verifies a single push only for
committed outcomes. `tests-emulator/abandon.test.ts` covers atomic burn/archive,
rollback, allocation across environments, replay, and controlled abandonment races.

# Publish controls and recovery (#129, #128, #127, #126, #119)

## Plate Pipeline gate

Publish checks the target catalog environment for queued or running workflow
records and standalone jobs. Legacy worker records can use a device namespace
that differs from their Batch's environment. The gate reads Batch IDs by catalog
environment, then uses those IDs to query jobs and runs in groups of 30. The
lookup reads status metadata from that catalog's history and uses existing
single-field indexes. It needs no migration or index rollout. Admission reads
the shared Publish lease inside the queue transaction, and the pointer
transaction repeats the scoped gate before advancing the Catalog.

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
State orders and their authoritative Catalog versions are written atomically in
`stateOrder` and `stateOrderVersion`. A receipt's own order records its own
published version. A late replay skips States with newer recorded
versions while finishing its own receipt and Batch bookkeeping. Independent
States with older recorded versions or no existing order still receive its order;
same-version writes remain idempotent. An existing legacy order without version
metadata is reconciled from the live committed Snapshot when the replay's version
is below the Catalog pointer. Snapshot reads happen outside the transaction and
must match the pointer's version and SHA256, including the canonical published
bytes. The transaction rechecks the pointer version and hash, committed receipt
and lease before writing that Snapshot's order with that Snapshot's version.
This also repairs a legacy State that the newer Publish did not touch. Pointer
movement triggers a fresh read, bounded to three attempts. Unreadable or invalid
authoritative data, or repeated pointer movement, returns `unavailable` and leaves
the receipt and Batch bookkeeping retryable. A replay never labels its own order
with a newer Catalog version.
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
live run exists, it keeps the claim locked; TTL
takeover requires an affirmative lookup showing no run. Unknown lookup state
fails closed. A delayed start response cannot bind once its claim was replaced.
Workflow lookups happen before the Firestore transaction. The transaction re-reads
and compares the claim identity and run binding; a changed claim stays locked and
the next request performs a new lookup. GET preflight uses read-only transactions
and does not bind runs, start work, or advance a Batch revision. Acceptance may
persist a recovered run binding after the same Firestore recheck. A missing claim document is treated as expired and
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
Before entering the pointer transaction, the commit path checks current object
metadata and the generation-selected bytes, then reads metadata again. The
Firestore-only transaction rechecks the lease, authority, receipt and its exact
object identity tuple. Snapshot writes remain create-only. A different generation, token, metageneration or hash
returns `version_taken` without advancing the pointer, even when the bytes are
identical. A recreation before metadata capture may instead refresh the receipt
to the verified current generation and its current token.

## Abandon a prepared Snapshot

Abandonment is optional disposition, not a prerequisite for another Batch to
publish. The allocator skips held slots, so another eligible Batch can publish at
the next free version while the stopped receipt remains intact. An active Owner
may select **Abandon prepared Snapshot** for a stopped or takeover-eligible attempt
and supply a reason. This action is available while paused. It never advances the pointer.
Editors and unauthenticated requests are denied; the transaction rechecks the
Owner's member document and authority marker. A live command claim refuses
abandonment, even if the receipt still names an earlier stopped command. The
current claim must have a durable stop or satisfy the same terminal/confirmed
absent-run takeover rules as [explicit retry](#explicit-retry-of-the-same-batch).
Unknown or transient Workflow lookup results stay locked.

Under the Publish lease, one Firestore transaction verifies that the receipt is
uncommitted and no receipt in any environment has committed its target. The live
pointer may already have passed that unused target: disposition still cannot
advance or roll back the Catalog. No object or checksum proof
is required: a crash before upload can also be abandoned. The transaction archives
the receipt as `publishRecords/{batchId}@{revision}--{commandId}`, marks it
`abandoned`, stops every command bound to it (including the current Batch claim),
records the disposition on the Batch, and creates `publishVersionBurns/{version}`.
The audit records actor, time, reason, and the observed object identity tuple
(generation, metageneration, hashes and URL), or explicit `null` for no object.
Different or missing bytes do not prevent abandonment. Duplicate requests return
the original disposition; a failed transaction leaves all these records unchanged.
Concurrent abandon requests may return one success and one locked response; retry
the locked request to obtain the same recorded disposition.
The original receipt key is freed only by this atomic archival operation, so a
fresh same-revision command recomputes bytes and receives a new receipt identity.
The archived attempt is never adopted.
Abandonment can also dispose of a stopped older receipt after its Batch has been
fenced out of approved; it does not require the Batch to remain publish-eligible.
It uses the global lease without creating a new Batch publication reservation.

Allocation chooses the smallest safe integer above the live pointer that is not
burned, held by any un-abandoned receipt, or targeted by any committed receipt in
any environment. Stopped receipts hold their versions until retry or abandonment.
The durable receipt reserves its target before upload; replay preserves that
target. With no excluded slots, allocation remains `pointer + 1`. Adoption proves
the receipt's reserved, unburned target and pointer at `fromVersion`, rather than
requiring adjacency. The blob's internal version always equals its target.

Disposition-only abandonment is a receipt audit record. It never touches committed
receipts or objects. No Snapshot is deleted or overwritten. A delayed old create-only upload may still
land in the burned slot, but pointer advancement rejects burned targets and
abandoned receipts. Command stops also fence retries and late receipt writes.
Version gaps are safe for consumers: the game requires a newer pointer and a blob
whose internal version matches it; curator reads use committed versions. Never
reuse burned numbers. Any future orphan-object garbage collection must check every
committed reference across all receipts and the pointer history before deleting
anything, even when an abandonment or burn marker exists. Deletion must also use
the object's generation precondition. That work is a separate follow-up, outside
this recovery action.

Abandon before a fresh click permits a new attempt at the next available version.
A fresh click that owns a live run wins the opposite order: abandonment is refused
until that run stops. Committed receipts and every target with a committed receipt
are protected, including commits recorded by another environment. The workspace reports refusal reasons and the final actor, time and
burned version.

## Operator recovery table

| Observed state | Owner action | Result |
| --- | --- | --- |
| Stopped, same approved revision, unchanged baseline | Resume if needed, then Publish again | Fresh authority; verifies and adopts the reserved receipt and bytes |
| Stopped, choose another Batch | Publish the other eligible Batch; optionally abandon the stopped attempt for disposition | The allocator skips its held slot without requiring abandonment; old commands stay stopped |
| Stopped before upload | Retry, publish another eligible Batch, or optionally abandon with a reason | The slot remains held until disposition; missing object does not prevent abandonment |
| Uncommitted target is below the live pointer | Optionally abandon for disposition | Audit and burn only; pointer and storage remain untouched |
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

If a legacy `receipt_baseline_conflict` has an unused uploaded blob, fresh review
can proceed while the allocator skips its held target. Optionally use
[abandonment](#abandon-a-prepared-snapshot) for disposition after the command stops.
Leave the blob untouched.

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

Members writes must use deployments containing #127. Older mutation paths do not
advance the [authority marker and tombstone history](#pause-and-resume). Never
hard-delete Members documents or reset their epochs during restoration.

### Fence older Workflows before Resume

Approval Workflows execute the deployment that started them. Before Resume,
inventory waiting and executing runs by Batch, revision and starting deployment.
Fence uncommitted runs from older deployments by moving their Batches out of
approved through the normal review edit flow, and verify the authoritative state
prevents every older run from advancing a pointer. Already committed receipts
finish bookkeeping instead. Then Submit and Approve again on the fixed deployment,
or Copy stale proposals for fresh review. A redeploy, route change or Resume does
not retrofit controls into an old run. Pause alone cannot fence code that ignores
it. Hosted proof with newly started runs and this fence remain release gates.

### Rollback

Deployments before #129 ignore burns and held receipts: they can target
pointer + 1 and commit a burned or held slot. Never roll back below the #129
deployment while burns or held receipts exist. Fence or pause publishing first,
following the [older-Workflow fence](#fence-older-workflows-before-resume); pause
alone is insufficient for code that ignores it. Keep every route capable of
publishing on code that understands burns and holds. Dashboard rollback does not
undo a committed Catalog release; Catalog recovery publishes reviewed content as
a higher, unburned version.

A separately authorized hosted staging check must use isolated data and newly
started Workflows to exercise stale recovery, commit ordering, receipt adoption,
optional disposition and committed-only Catalog push. No deployment, real Catalog
Publish, staging writes or production Firebase access occurred during local
verification.

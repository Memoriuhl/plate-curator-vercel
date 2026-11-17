# Architecture notes per screen

Copied from the design canvas. Each note says what is server-rendered, what updates live, what writes and what waits durably.

Until decision 25 (browser Firestore listeners) is settled, "live" reads use the SWR hooks in `lib/client/hooks.ts`, each behind a hook so listeners can replace it later.

## Dashboard

- Server-rendered: the frame (top bar, nav, region picker) and the jurisdiction list.
- Live: plates, the open Review batch and who is online come from Firestore listeners in the browser. No polling, so watching costs no Vercel invocations.
- Writes: every drag, ★, tag or rarity change is one small operation to a Route Handler, saved to the batch immediately.
- Durable: a pipeline run is a Workflow run. The lock is the run itself, so a closed tab or a redeploy never frees it early.
- After Publish: the pointer moves; the Dashboard's 'live version' chip updates from the listener.

## Plate page

- Own URL (/plates/AK.army), so it can be shared and opened in a new tab.
- Field drafts stay local while typing; a save sends one operation. If someone else changed the same text field first, the conflict view opens instead of overwriting.
- Suggested tags: the current page polls the Tag job ids it retains locally. Reload does not rediscover jobs or restore the picker; tagging durability/reload discovery is deferred in #9.
- A dismissed image suggestion is stored, so it never comes back for this plate.

## Inbox and review

- Accept adds a 'new plate' operation to the Review batch; nothing reaches players until approve + Publish.
- Decline writes the denylist row at once (with a few seconds of Undo).
- Review shows a frozen Batch revision. Approve names that revision; any later edit invalidates it.
- The approval wait is a durable Workflow hook: the Owner can approve hours later, after a redeploy.

## Publish

- Owner-only; Editors never see the button.
- Create-only upload of the immutable snapshot, then a conditional pointer advance.
- Disabled while the contract check fails or the batch is older than live.
- Region picker: jurisdiction lists are server-rendered per region; codes are unique across the catalog.



## Shared Batch live reads

Batch creation and every successful review commit write exactly `{ revision }` to
`curatorLive/{encodeURIComponent(reviewEnv())}/batchRevisions/{batchId}` in the
same transaction as the draft. A rejected or failed commit cannot announce a new
revision. The authenticated Batch detail API reads metadata and proposed edits
in one read-only transaction; draft contents stay behind that API.

`POST /api/live-access` uses the existing Member or configured Owner authorization
and merges a one-hour Firestore Timestamp into
`curatorLiveAccess/{uid}.envs[envKey]`. Removing a bound Member deletes the grant
in the same transaction. The versioned rule permits only individual signal reads
with a fresh grant for that environment. Client writes, listing, grant reads and
all other document access are denied.

Existing staging Batches can receive missing signals with `npm run backfill:signals`.
The script checks the staging project before accessing Firestore, scopes the scan
to the current review environment, and transactionally initializes only missing
signals from the current batch revision. It does not overwrite an existing signal.
The script is provided for a separate staging operation; it is not run as part of
implementation or deployment.

Rules are not deployed from this repository. Staging rules belong to
`License-Plate-Game/firestore.rules`; deploying requires merging the live signal
and grant blocks into that file while retaining the game's existing rules.

With `?batch=<id>`, Dashboard and Plate field edits, drags and Tag actions target
that selected Batch. An unavailable or read-only selection blocks writes instead
of falling back to a personal Batch. Tag additionally requires an open Batch.
Without a selection, `useEnsureBatch` still reuses the most recent personal open
Batch; whether an older open Batch should be reused is an unresolved product choice
(`lib/client/hooks.ts`, `components/dashboard/use-tag-run.ts`).

Detail, authoritative edits (including combined promotion) and Tag job input/hash
use the immutable Catalog snapshot named by the Batch's required `baselineVersion`.
Saved fields overlay that snapshot; a live Catalog advance does not change its
before-values or revision basis (`lib/review/queries.ts`, `lib/review/batch.ts`,
`lib/jobs/jobs.ts`, `lib/server/context.ts`). Publishing still rejects a stale
baseline; Copy to new Batch rebases proposals onto the live Catalog for fresh review.

A Plate save must match the revision of that Batch's current proposed Plate.
A real conflict returns `stale_plate` with the saved Plate and `currentRevision`.
Reapply sends only the attempted fields to the same Batch using that returned
revision; another intervening save can conflict again. State order writes instead
require the displayed Batch revision (`lib/server/respond.ts`,
`lib/client/hooks.ts`, `components/plate-page/plate-page.tsx`).

When live signals are unavailable, the selected-Batch bar offers Refresh to fetch
the authenticated Batch detail explicitly (`components/dashboard/selected-batch-bar.tsx`).
Tag job visibility is separate: the job-by-id API permits the requesting user or
an Owner; selecting the same Batch does not grant another Editor access to that
job (`lib/jobs/jobs.ts`, `app/api/jobs/[id]/route.ts`).

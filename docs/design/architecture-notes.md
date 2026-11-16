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
- Suggested tags: a tagging job is a durable Workflow wait on the GPU worker; the picker fills when the result arrives, even after a reload.
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


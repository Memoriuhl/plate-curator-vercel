# Try the review demo

Plate Curator is invite-only. Only Members can sign in, and an Owner adds Members from the Members page. Reviewers use the two demo accounts from the submission, which are already Members.

## Sign in

1. Open `/sign-in` and enter the demo account's email, then choose **Continue**.
2. The demo accounts sign in with a password, so the page asks for the password from the submission. Members invited with a Google account see **Continue with Google** instead.
3. An email that isn't a Member gets "Plate Curator is invite-only" and no sign-in prompt. The email check is rate-limited.

## Walk through the loop

1. Sign in with the demo Editor account and open AK at `/states/AK`.
2. Open a Plate, add or remove a Tag, and wait for **Saved to your batch**. Every curator's changes go into one shared draft; there is no Batch to pick.
3. Return to AK and drag a Plate into another position; the order saves to the same draft.
4. Open `/review?state=AK`. Review lists every unpublished change in the draft, yours included, with who made it and when.
5. Sign out, then sign in with the demo Owner account. Open `/publish` and inspect the draft at its current revision, broken down by state. Publishing ships that revision; changes saved after it stay in the draft. The walkthrough stops at inspection.

## Reset the example

Install dependencies with `npm ci`. Configure staging credentials in `.env.local`, and supply the Editor uid, display name and review environment through inputs:

```sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/seed-demo.ts --uid "$DEMO_EDITOR_UID" --name "$DEMO_EDITOR_NAME" --env development
```

In PowerShell, set `$env:NODE_OPTIONS='--conditions=react-server'` before running the same `npx tsx` command with your input variables. The alternatives to flags are `DEMO_EDITOR_UID`, `DEMO_EDITOR_NAME` and `REVIEW_ENV`.

The script requires the staging project, reads the current Catalog version, and resets this Editor's demo Batch in the selected review environment. Published Batches cannot be reset. After a demo Batch is published, the next seed uses the first unpublished or unused numbered generation. Verification uses `development` only.

The seed predates the shared draft: it writes a per-person demo Batch, which Review and Publish don't show. The walkthrough above doesn't need it. Moving the seed onto the shared draft is a follow-up.

## Repeat the tagging evaluation

Set `GAME_REPO` to the game checkout directory before running `npx tsx worker/eval.ts` or `npx tsx worker/try-model.ts`. Both commands require this variable and exit with a clear error when it is unset or blank. `MODEL` and `OLLAMA_URL` use the same defaults as the worker; the default service is localhost. The runner uses the worker image reader and tagging adapter with their existing prompt and settings. Curated answers are withheld from inference. Results record per-Plate timings and tag scores, plus overall micro precision, recall and F1. Case, surrounding whitespace, duplicate Tags and blank Tags do not affect scores. Both sets empty score 1; no suggestions against a nonempty answer scores 0; recall against an empty answer is 1.

The dated JSON report is written before the threshold check. A failed inference is retried once. Persistent failures are recorded with empty suggestions and count against recall. The command exits nonzero when overall F1 is below the committed minimum or more than 20% of Plates still fail after retrying. Exactly 20% failures is allowed when F1 meets the minimum. Missing images or invalid configuration stop the run. The initial threshold is calibrated slightly below the first measured run; it is a regression check on this fixed sample, not a quality guarantee for every Jurisdiction.

The first complete run measured micro F1 0.629, with two tagging failures among 30 Plates. The minimum is 0.600. Its report used a bootstrap threshold of zero before calibration and predates the retry policy; its nonzero exit reflected the earlier rule that any tagging failure failed the run. The reference set contains 15 AK and 15 AL Plates from Catalog v12. Both Jurisdictions are still in progress; no completed Jurisdiction was available. This explicitly approved provisional sample measures agreement with existing curator-reviewed Tags, not completed-state ground truth.

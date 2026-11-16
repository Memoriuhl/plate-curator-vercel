# Try the review demo

Use the demo Editor / Owner account from the submission.

1. Sign in with the demo Editor account at `/sign-in` and open AK at `/states/AK`.
2. Open `/review?state=AK`, find **Demo: Alaska field edits and grouping** in your open Batches, and inspect its changes. It already contains Tags, a description, a Standard change, a Plate regrouped as a variant, and a changed State order.
3. Return to `/states/AK`, open a Plate, add or remove a Tag, and wait for **Saved to your batch**. Edits use your most recent open Batch, which is the freshly seeded demo Batch.
4. Return to AK and drag a Plate into another position; the order saves to the same Batch.
5. Open `/review?state=AK`, select the demo Batch, inspect the changes, and choose **Submit for review**.
6. Sign in with the demo Owner account. Open `/review`, inspect the submitted Batch, and approve it.
7. Open `/publish` and inspect the approved Batch and its changes.

## Reset the example

Install dependencies with `npm ci`. Configure staging credentials in `.env.local`, and supply the Editor uid, display name and review environment through inputs:

```sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/seed-demo.ts --uid "$DEMO_EDITOR_UID" --name "$DEMO_EDITOR_NAME" --env development
```

In PowerShell, set `$env:NODE_OPTIONS='--conditions=react-server'` before running the same `npx tsx` command with your input variables. The alternatives to flags are `DEMO_EDITOR_UID`, `DEMO_EDITOR_NAME` and `REVIEW_ENV`.

The script requires the staging project, reads the current Catalog version, and resets this Editor's demo Batch in the selected review environment. Published Batches cannot be reset. Verification uses `development` only.

## Repeat the tagging evaluation

Set `GAME_REPO` to the game checkout directory before running `npx tsx worker/eval.ts` or `npx tsx worker/try-model.ts`. Both commands require this variable and exit with a clear error when it is unset or blank. `MODEL` and `OLLAMA_URL` use the same defaults as the worker; the default service is localhost. The runner uses the worker image reader and tagging adapter with their existing prompt and settings. Curated answers are withheld from inference. Results record per-Plate timings and tag scores, plus overall micro precision, recall and F1. Case, surrounding whitespace, duplicate Tags and blank Tags do not affect scores. Both sets empty score 1; no suggestions against a nonempty answer scores 0; recall against an empty answer is 1.

The dated JSON report is written before the threshold check. A failed inference is retried once. Persistent failures are recorded with empty suggestions and count against recall. The command exits nonzero when overall F1 is below the committed minimum or more than 20% of Plates still fail after retrying. Exactly 20% failures is allowed when F1 meets the minimum. Missing images or invalid configuration stop the run. The initial threshold is calibrated slightly below the first measured run; it is a regression check on this fixed sample, not a quality guarantee for every Jurisdiction.

The first complete run measured micro F1 0.629, with two tagging failures among 30 Plates. The minimum is 0.600. Its report used a bootstrap threshold of zero before calibration and predates the retry policy; its nonzero exit reflected the earlier rule that any tagging failure failed the run. The reference set contains 15 AK and 15 AL Plates from Catalog v12. Both Jurisdictions are still in progress; no completed Jurisdiction was available. This explicitly approved provisional sample measures agreement with existing curator-reviewed Tags, not completed-state ground truth.

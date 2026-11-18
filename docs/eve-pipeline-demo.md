# Eve pipeline rehearsal

**Run Pipeline → Research / enrich** proposes a Wikipedia link, description, and
story fields in a single queued stage. Select Desktop / Ollama or Vercel / Eve and
choose Fill missing or Replace existing. A normal run saves a draft only after
explicit Apply. Preview runs are for inspection.

An isolated browser rehearsal with the installed Workflow SDK restored the same
run after reload, displayed a sourced Alaska fact and link, and saved one draft
through explicit Apply. The Eve response and source capture were fixtures. SDK
tests also verify that a source-empty run stops without dispatch and that Preview
cannot Apply. A live hosted rehearsal is still required.

## Matching runtime and configuration gate

There is **no verified matching deployed Preview for the queued Eve stage**. The old
#178 Preview at `e39ac92` predates queue session binding and scoped queue tokens.
Its health alone cannot establish compatibility. Use a protected
Eve Preview carrying the exact candidate code (or independently reviewed equivalent
runtime modules). Record the immutable deployment URL, deployment ID, and source
SHA. Pair the local coordinator with that same source pin.

Provision the new matching pair with `RESEARCH_ENABLE_MODEL_CALLS=false` first.
With paid calls off, verify build/deployment metadata, health, unauthenticated
session refusal and the paired environment/scope/project, then sign in and verify
the model-list endpoint's Owner response. Hosted selection remains hidden while
calls are disabled. Verify budget readiness separately before enabling calls for
this pair and starting the one-plate run. Do not modify the frozen Preview.

Use a local coordinator on localhost:3293 with its own absolute
`WORKFLOW_LOCAL_DATA_DIR` outside `.next`, `WORKFLOW_TARGET_WORLD=local`, and
`WORKFLOW_LOCAL_BASE_URL=http://localhost:3293`. Research-only Eve execution needs
no desktop worker. Retain localhost for the general pipeline: the desktop worker's
`assertLocalWorker` requires HTTP localhost and concurrency 1; a hosted queue URL
cannot replace it without a separate design change.

| Setting | Required pairing |
| --- | --- |
| `GCP_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Both sides use `license-plate-game-staging`; never the production project. |
| `NEXT_PUBLIC_LOCAL_PIPELINE`, `LOCAL_PIPELINE_SCOPE` | `1` and a new dedicated `eve-demo-step` scope on both coordinator and Eve. Queue/job environment is `preview:local-pipeline-eve-demo-step`. |
| `VERCEL_ENV`, `VERCEL_GIT_COMMIT_REF` | Local coordinator mirrors the matching Preview's actual values. Review/research state namespace must be identical: `preview:<actual-ref>`. Matching the queue scope alone is insufficient. |
| `RESEARCH_EVE_URL` | Local coordinator targets the immutable matching protected Preview, not the old alias. |
| `RESEARCH_SERVICE_SECRET` | Same existing authorized secret on both sides, at least 32 characters; provision securely, never in prompts or commands. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Existing authorized protection bypass on the local caller for the cross-deployment request. Same-deployment trusted OIDC does not cover this localhost-to-Preview hop. |
| `RESEARCH_ENABLE_MODEL_CALLS` | Enable only in these dedicated processes after confirming the live allowance and readiness. Keep production and unrelated Preview settings unchanged. |
| `RESEARCH_BUDGET_ID`, `RESEARCH_BUDGET_USD` | Executing Eve runtime uses a reconciled allocation from the existing authorized campaign; see below. |
| `AI_GATEWAY_API_KEY` or Vercel Gateway OIDC | Existing authorized Gateway access on the executing Eve runtime. Local coordinator does no synthesis. |
| `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`, `GCP_SERVICE_ACCOUNT_EMAIL` | Existing staging Workload Identity setup; local linked-project OIDC and Preview identity must both read the paired jobs/research state. |
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `OWNER_UIDS` | Existing staging sign-in configuration; use the current active Owner membership. |
| `CATALOG_SOURCE`, `EVE_DEV`, `FIRESTORE_EMULATOR_HOST` | Live: `firestore`; do not set `EVE_DEV=1` or the emulator host. File-backed local Eve research state would not pair with the remote runtime. |

Environment names above intentionally contain no secret values. This path needs
neither a research desktop token nor a new desktop worker. Wikipedia-only captured
research needs no Serper/Brave credentials or nested search calls.

Budget is an actual readiness gate. The documented prior authorization is USD 2
total, with a USD 0.50 Preview allocation inside that total, not an ongoing/new
allowance. Verify that the existing allowance covers this run and read the current campaign
and Gateway accounting. Each physical synthesis reserves USD 0.20
before calling; fewer than USD 0.20 of available headroom refuses the attempt.
Do not reset the limit to the USD 2 default or create a fresh funded campaign.
`researchState` budgets are namespaced by environment as well as campaign id:
reusing `RESEARCH_BUDGET_ID` on a new Preview ref does **not** reuse the old ledger.
Reconcile any dedicated allocation within the existing total before enabling it.
One plate is restricted to one physical synthesis call, with context/output caps;
unknown cost retains conservative reservation accounting.
The USD 0.20 is an application reservation, not a verified provider-enforced
Gateway spending ceiling. No provider-side ceiling or current balance was
verified in the fixture rehearsal. Existing Gateway ceiling/balance, remaining
campaign allowance and any dedicated allocation remain explicit live preflight
checks. No new key, funding or cap change is part of this recipe.

## One-plate hosted rehearsal

1. Record both exact build pins and the matching Preview's immutable deployment
   metadata. Verify ready health, unauthenticated session rejection, paired staging
   project/namespace/scope, current active Owner, no jobs already active in the new
   scope, original catalog pointer and paused generation, existing capped Gateway
   access and remaining campaign headroom. Do not change the catalog pause.
2. Sign in normally through Firebase to localhost:3293 as that Owner. Create a
   fresh owned staging Batch. Select only `FL.standard_sunshine`; use the corrected
   [Florida registration plate source](https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Florida).
   Preflight fetched passages first: the exact registration-plate article must
   resolve and contain useful text. If current Fill missing would plan no work,
   choose Replace existing explicitly for this fresh draft, without editing the
   baseline or clearing fields. Deselect other stages and select the hosted model
   above. Start once, with Preview off. Reload while in flight.
3. Follow the saved run → job → Eve session/delivery → Gateway trace. Require
   exactly one physical request to `google/gemini-2.5-flash-lite`, no fallback or
   nested search, actual token usage and reported charge (or explicit missing
   cost). Distinguish requested model in the job from the Gateway trace's actual
   model. Require a grounded Wiki link, description or fact with a captured source;
   open it in the coherent result and explicitly Apply. Verify one draft revision
   and the cited saved field, with no unrelated edits and unchanged catalog/pause.

If retrieval has no usable passages, require persisted `no_result` / `no_sources`
with zero model attempts. That proves the guard, not live synthesis acceptance.
Preview is a separate inspect-only run and cannot later become applicable; local
SDK and existing UI/service tests already cover its refusal without a second live
charge. Do not retry automatically after an ambiguous paid dispatch.

This one-plate path can cover the hosted pipeline/explicit-Apply portion of the
Owner walkthrough once the Owner witnesses it. It does not finish the separate
#178 remote conversation, desktop executor, comparison/quality and issue-closure
requirements. Preserve the existing Owner walkthrough ticket until its owner
records which criteria this run fulfills.

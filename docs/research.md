# Research agent setup and operation

Tracking: [#170](https://github.com/Memoriuhl/plate-curator-vercel/issues/170).
Research supports desktop/Ollama and Vercel/Eve execution.

## Where the files live

| Path | Purpose |
| --- | --- |
| `agent/instructions.md` | Research sequence, evidence rules, and completion criteria |
| `agent/agent.ts` | Explicit Gateway model, optional tools, model-call gate, and limits |
| `agent/channels/eve.ts` | Terminal/HTTP channel authentication |
| `agent/tools/` | Wikipedia, existing web search, page reading, and draft submission |
| `lib/research/` | Evidence, validation, budgets, persistent state, and research jobs |
| `worker/research-legacy.ts` | Calls the existing desktop story implementation |
| `worker/research-benchmark.ts` | Freezes inputs and runs desktop, Eve, and identical-evidence comparisons |
| `worker/research-report.ts` | Summaries, CSV, and a local blind review page |
| `components/research/` | Host choice, durable progress, citations, and field acceptance |
| `workflows/research.ts` | Hosted dispatch and completion reconciliation |
| `fixtures/research-eval-v16.json` | Frozen 20-plate corpus (Snapshot v16) and rubric |

## Talk to the agent locally

Run commands from this feature checkout. Install its pinned dependencies with
`npm ci`, then start the terminal interface:

```sh
npm run research:chat
```

This opens Eve's development terminal. To resume local saved sessions after a restart, use `npm run research:chat -- --resume`. Without that flag, Eve leaves old local Workflow runs dormant. `/login` configures a Vercel/AI Gateway
connection, `/new` starts another conversation, `/info` shows the resolved agent,
and `/exit` leaves the terminal. The existing desktop/Ollama pipeline remains the
application's desktop executor; this command is the Eve authoring interface.

Model calls default to disabled. The pilot and comparison were authorized for
USD 2 total on 2026-11-17. Local calls were disabled after measurement; the feature
Preview has a separate USD 0.50 campaign cap within that same total. This is not
an ongoing spending authorization.
Once authorized, set `RESEARCH_ENABLE_MODEL_CALLS=true` in an ignored `.env.local`
or the executing process environment. The selected model is explicit in `agent.ts`;
the current hosted default is `google/gemini-2.5-flash-lite`. The original
GPT-6.1-Sol benchmark remains historical evidence; existing artifacts are not
rewritten or relabelled. New agent, control and explicitly selected nested search
calls use the cheap hosted default and retain the existing budget gates.

For existing web search, configure `SERPER_API_KEY` and optionally `BRAVE_API_KEY`
on the executing host. Without keys, Wikipedia remains available and web search
reports its unavailable status. API keys belong in the environment or Eve's login
store, never in prompts, committed files, or benchmark artifacts.

Example conversation after the pilot is enabled:

> Research Arizona's Arizona Highways plate. Explain its purpose, suggest up to
> four useful fun facts, and show the source supporting each claim.

The terminal is conversational. A pipeline request instead asks for a structured
draft, which stays pending until a curator accepts fields through the application.

## Talk to the deployed agent

The Next.js integration mounts the agent at `/eve/v1/*` on the application domain.
Production access requires the research channel's verified Owner identity and
session ownership checks. The channel checks current membership and session ownership on reads and controls as well as starts. The feature Preview is deployed; an authenticated remote terminal conversation remains unverified.

After deployment and authentication are configured, connect using the configured
target and a fresh authenticated token:

```sh
npm run research:remote -- --url "$RESEARCH_EVE_URL" \
  -H "Authorization: Bearer $RESEARCH_FIREBASE_ID_TOKEN"
```

The token must belong to a current active Owner. A removed user loses access, and
an Owner cannot read another user's session by guessing its ID. An expired Firebase
token needs renewal. Deployment Protection may additionally require its bypass
header; it is separate from the agent's authentication.

Verify compiled runtime plumbing without a paid model call:

```sh
npm run research:build
```

The generated `.eve/` and `.output/` directories are ignored. `npm run build` builds
the Next.js application; the Vercel integration also registers the Eve service.

## Preserve the baseline

`npm run research:baseline` validates the draft corpus without contacting a model.
Freeze its inputs from an explicit catalog Snapshot:

```sh
npm run research:baseline -- --input snapshot.json \
  --output eval-results/research-baseline/manifest.json
```

This refuses missing plates and an existing output file. Desktop runs write per-plate versioned artifacts that the control and reporter consume directly; the initial legacy aggregate remains readable for audit. The draft corpus must be
reviewed and frozen before measured runs. Model and prompt identities, source text,
cache use, rejections, raw outputs, and known/missing costs belong with the results.
Raw artifacts under `eval-results/research-*` stay local and ignored.

## Pipeline setup

Research starts from the Plate screen within an editable Batch. Owners choose
**Desktop / Ollama** or **Vercel / Eve** for each run. A replacement fences the older
run; changing the picker does not migrate work already running. Accept selected fields
only after inspecting their captured passages. Acceptance proposes Batch edits and
invalidates approval. `sourceUrl` remains image provenance.

Only Owners can edit proposed text. Editors may accept stored wording or deselect
content. Owner edits still require captured evidence and the shared field validation.

The desktop bridge uses the neighboring private legacy checkout, pinned with
`RESEARCH_LEGACY_REVISION`, and only calls its story stage. It does not apply a catalog
write. Configure `API_BASE`, a research-only `RESEARCH_WORKER_TOKEN`, and
`RESEARCH_LEGACY_ROOT` in the desktop's ignored `.env.local`, then run:

```sh
npm run research:worker
```

An authenticated Owner issues a research token with
`POST /api/research-worker/tokens` and `{ "workerId": "desktop" }`. Keep its returned
value private. Revoke it through `DELETE /api/research-worker/tokens/{hash}`. It cannot
accept edits or Publish. Do not reuse a tagging token.

For a protected same-project Preview, the worker also sends a short-lived
`VERCEL_OIDC_TOKEN` as `x-vercel-trusted-oidc-idp-token`. Obtain it through the
linked project's `vercel env run`; the research token still authenticates the
application request. Restart through `vercel env run` when that OIDC token expires.
The current desktop Preview launcher loads its private environment file before
starting the worker. Add search keys to that same file rather than an unrelated
checkout's environment. Keep tokens out of saved command text and committed files.

For Vercel, keep the Gateway/search keys and a random `RESEARCH_SERVICE_SECRET` of
at least 32 characters as environment secrets. The service secret signs a short-lived
capability bound to one job, requester, and environment. Configure a separate
`RESEARCH_BUDGET_ID` and an authorized `RESEARCH_BUDGET_USD` (pilot maximum 2). A capped
Gateway key adds an independent spending boundary. The current pilot key expires in
seven days; continuing usage needs a new explicit budget and credential setup.
Deploy `firestore.indexes.json` with the existing rules before claiming desktop jobs.
The initial production default remains `RESEARCH_ENABLE_MODEL_CALLS=false`.

## Repeat the benchmark

Use one immutable manifest and one output directory per variant; existing output
files are preserved. Benchmark scripts load ignored `.env.local` automatically.

```sh
npm run research:benchmark -- --run --budget-usd 2 --executor eve \
  --manifest eval-results/research-baseline/manifest.json \
  --output eval-results/research-eve-v1
npm run research:benchmark -- --run --budget-usd 2 --executor control \
  --manifest eval-results/research-baseline/manifest.json \
  --baseline eval-results/research-baseline \
  --output eval-results/research-control
npm run research:report
```

`--budget-usd` must match the shared executing-runtime campaign cap; it is not a new
budget per invocation. The control has no retrieval tools and consumes the exact
captured desktop passages. For the separate Gateway Parallel experiment, set
`RESEARCH_SEARCH_PROVIDER=gateway-parallel` on the Eve server and benchmark process,
then use `eval-results/research-eve-parallel-v1`. Restart the local server with the
standard environment afterwards. Parallel's provider tool needs an additional Sol
call; both that model call and search charges are recorded and bounded. The default
research provider remains the existing Serper/Brave adapter.

Raw outputs, source passages, receipts, usage, and the local blind review page stay
under ignored `eval-results/research-*` directories. Operational status and lexical
checks are screening results, not factual-quality scores. Curator acceptance and
correction effort need an actual blind review; they are not inferred from coverage.

## Verification and deployment status

The local real pilot and all three initial 20-plate comparisons run without catalog
applies. Tests cover retry identities, stale/replaced results, worker renewal,
source validation, field preservation, and mocked publishing serialization. The
Firestore emulator checks actual transactions. Next and Eve production builds check
runtime coexistence. Live catalog Publish was not performed.

The feature Preview is ready from commit `31140bd`. Its Eve health check returns
ready, unauthenticated session
creation returns 401, and the separate desktop research worker authenticates and
polls successfully (204 when idle). Branch-scoped secrets and Firestore research
indexes are configured. Deployment Protection remains enabled; the exact Preview
alias is registered for Firebase Google sign-in. Production is unchanged.

An Owner-started UI job, hosted service dispatch through completion, selected-field
acceptance on that Preview, and authenticated remote terminal use remain unverified.
Search-provider credentials are still missing; Wikipedia works without them.

This branch is rebased onto merged PR #174 and imports its shared story validators.
That PR owns the canonical shape: at most four facts and eight read-more links,
link title and site at most 200 characters, fact source title at most 300, and
HTTP(S) URLs at most 2048. Eve clips its display titles to 200 characters, provides
a non-empty site, and may generate at most four links. Its acceptance uses the
shared story validator; the local pipeline flag gates direct
Batch-edit input. The domain preserves validated story fields with that flag off,
as do Standard rebuilds and unrelated edits. The scoped review transaction and
image provenance are preserved.

## Dashboard bulk enrichment

With the local pipeline flag, select one or more Dashboard plates and choose
**Research / enrich** in Run pipeline. **Fill missing** is the default;
**Replace existing** may replace supported values but never clears a field when
a retrieval or generated draft has no result. Fully populated plates are skipped.
The server plans against the selected Batch and checks projected inputs again.
The separate **Research model** picker offers allowlisted Desktop/Ollama choices
and, for an active Owner with the existing model-call gate enabled, Vercel/Eve
with Gemini 2.5 Flash Lite. This preference is separate from Tag. The resolved
model and policy are persisted on the run and jobs, including retries.

Bulk research reuses the Wiki matching and bounded passage adapters. It fetches
evidence once per plate, synthesizes all requested fields in one call, and does
not invoke specialized web search. An Eve session receives captured passages,
exposes only the existing submit_draft tool and ends after that structured call.
Its model-call, context, output and campaign budget gates remain enforced. Actual
model, token usage and known/missing costs are retained with the queue result.
Missing required inputs stop chained work before inference; standalone enrichment
with no usable passages produces no result without a model call.

Suggestions remain in the queue projection until normal-mode **Apply** commits
the coherent bundle with revision checks. Preview is inspect-only. Source URLs
remain attached to facts and read-more links; plate-level sourceUrl remains image
provenance. No new research-job ledger is created for the bulk action.

The hosted default and its published $0.10/M input / $0.40/M output rate were
verified against the [Gateway model page](https://vercel.com/ai-gateway/models/google/gemini-2.5-flash-lite)
on 2026-11-17. This is configuration verification, not a new paid benchmark.

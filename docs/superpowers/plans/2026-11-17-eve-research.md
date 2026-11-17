# Eve Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer existing desktop/Ollama research and Vercel-hosted Eve/AI Gateway research, with reviewable sourced results and a comparison benchmark.

**Architecture:** Keep the legacy desktop story implementation intact behind a bridge. Introduce research jobs and typed evidence/results separately from tagging. Eve calls bounded Wikipedia, Serper/Brave, and page-fetch tools; both executors return drafts through the same validation and acceptance boundary.

**Tech Stack:** TypeScript, existing Next.js/React application, Firestore, Vercel Workflow, Eve, AI Gateway, desktop Ollama.

**Spec:** [Approved design](../specs/2026-11-17-eve-research-design.md). Read it before this plan.

## Global Constraints

- Before every prompt-writing section, invoke `mattpocock-skills:writing-for-agents`: instructions, tool descriptions, runtime requests, repair/follow-up prompts, and benchmark judges. Record the invocation with the task evidence.
- Desktop keeps the existing Ollama pipeline. Eve runs on Vercel with AI Gateway. Existing Wikipedia/Serper/Brave search comes first; Gateway search is a later experimental variant.
- One plate per integrated request; executor selection is fixed for that request. Owner-only starts during the pilot. Switching an existing request creates an explicit replacement, with the earlier run fenced from acceptance.
- Enforce three web-search queries, six fetched web pages, ten model calls, and a five-minute hosted deadline, including retries. Bound Wikipedia calls separately: two search requests and three article fetches per plate. Use a persistent ledger across resumption.
- Outputs are descriptions, zero to four cited facts, `readMore`, and relevant `wikiUrl`. `sourceUrl` retains image provenance. Missing research output never clears an existing field.
- Research returns staged drafts. Acceptance uses current membership, Batch access, and the captured input revision. Publishing follows the existing separate Owner action.
- The proposed paid pilot/benchmark cap is USD 2, including model/search charges. Obtain paid-run authorization and pin the model/corpus/limits before sending requests. Unknown cost is reported, never treated as zero.
- Use approved Sol/Terra workhorses for engineering/review. Every Astra version requires Jonathan's task-specific approval; prevent implicit fallback to Astra in application configuration too.
- Keep raw sources, credentials, and benchmark outputs out of Git. Apply the repository hygiene checks to committed artifacts and issue updates.
- Execution is a guided walkthrough: stop at meaningful behavior/configuration checkpoints for discussion, rather than silently completing prompt selection and paid experiments.

## Review Focus

1. A replacement request must make an older result ineligible for acceptance even if it finishes later — Task 5.
2. A fetched page may redirect to a private address or contain instructions to the agent; neither becomes trusted execution context — Task 2 and Task 4.
3. A user may be removed after starting a session; stale identity or a guessed Eve session ID must not expose evidence or permit acceptance — Task 5.
4. An accepted links-only or facts-only change must preserve image provenance and unselected existing fields — Task 6.
5. Cached search and unavailable credentials must remain visible in measured results so benchmark scores cannot conceal missing work — Task 7.

## File Map

- `lib/research/{types,validate,evidence,limits}.ts`: public contracts, result screening, evidence registry, persisted budgets.
- `lib/research/{search,wikipedia,fetch-page}.ts`: dependency-injected research adapters, using the existing provider behavior and public-page safeguards.
- `lib/research/{jobs,memory-store,firestore-store,tokens,hosted}.ts`: lifecycle, scoped worker identity, persisted execution and reconciliation.
- `agent/{agent.ts,instructions.md,channels/eve.ts,tools/}`: the Eve configuration, authored prompt, route policy, and bounded tools.
- `worker/research-{main,run,legacy}.ts`: outbound desktop bridge and legacy story invocation.
- `workflows/research.ts`, `lib/server/research-context.ts`: app orchestration and trusted dependency/auth setup.
- `app/api/batches/[id]/plates/[plateId]/research/route.ts`: start a plate request.
- `app/api/research/[id]/route.ts`, `app/api/research/[id]/accept/route.ts`: read and explicitly accept a draft.
- `app/api/research-worker/{claim,tokens}/route.ts`, `app/api/research-worker/jobs/[id]/{heartbeat,report}/route.ts`: research-only desktop capabilities; token revocation uses `tokens/[hash]/route.ts`.
- `components/research/{research-actions,research-result}.tsx`, `lib/client/research.ts`: execution selection, progress, citations, and field-level acceptance.
- `worker/research-{benchmark,report}.ts`, `fixtures/research-eval.json`, `docs/research.md`: reproducible evaluation and operating instructions.
- Extend existing review/catalog types, field validation, revision hashing, comparisons, and tests where accepted output enters the existing Batch model.

## Task 1: Freeze the baseline contract and evidence artifacts

**Files:** Create `lib/research/types.ts`, `worker/research-legacy.ts`, `worker/research-benchmark.ts`, `fixtures/research-eval.json`, `tests/research/legacy.test.ts`; modify `.gitignore` and `package.json`.

**Interfaces:**
- `ResearchInput = { plateId: string; displayName: string; state: string; inputRevision: string; baselineVersion: number }`.
- `ResearchExecutor = 'desktop' | 'eve'`.
- `EvidenceSource = { id: string; kind: 'wikipedia' | 'web'; title: string; url: string; fetchedAt: string; contentHash: string; text: string }`.
- `ResearchDraft` contains nullable description plus its source IDs, facts `{ text: string; sourceId: string }[]`, read-more source IDs, and nullable Wikipedia source ID. It does not contain arbitrary model-invented URLs.
- `ResearchResult` includes input, executor/model/prompt versions, sources, draft, per-field rejections, attempts, timings, counters, cache status, and known/unknown costs.
- `ResearchJob` captures request identity, input, Batch/requester/environment, executor/config, deadline, counters, optional desktop claim and Eve receipt, evidence/result references, and terminal metadata. Its states are `queued | running | completed | failed | expired | superseded`.
- `runLegacyResearch(input: ResearchInput, options: { legacyRoot: string; model: string }): Promise<ResearchResult>` adapts the legacy story function with the captured identity.

- [ ] Add a fixture test asserting the bridge passes captured name/state/ID to an injected legacy runner, translates source references, and leaves catalog-writing capabilities unavailable. Reject a loaded legacy implementation/version that differs from the benchmark manifest.
- [ ] Run `npx vitest run tests/research/legacy.test.ts`; confirm failures identify the missing adapter/contract.
- [ ] Implement the adapter and manifest writer. Resolve the configurable legacy checkout only on desktop. Store raw runs under an ignored `eval-results/research-*` directory. Freeze a draft 20-plate corpus with a `tuning` or `held-out` split and rubric before prompt tuning; review the final selection with Jonathan before measured calls.
- [ ] Verify the test passes. Add `research:baseline` and `research:benchmark` scripts whose default is configuration validation; execution requires an explicit run flag and budget. Do not invoke a real model in this task.
- [ ] Commit the baseline harness and contracts. Record the exact legacy code/model/prompt identity before any baseline execution.

## Task 2: Recreate existing research services behind bounded tools

**Files:** Create `lib/research/{search,wikipedia,fetch-page,evidence,limits}.ts`, `tests/research/{retrieval,fetch-page,limits}.test.ts`.

**Interfaces:**
- `searchWeb(query: string, deps: SearchDeps): Promise<SearchOutcome>` returns provider, cache status, hits, and explicit unavailable/capped/error status. Preserve legacy provider-order and fallback conditions; label any intentional correction separately.
- `fetchResearchPage(url: string, deps: PageDeps): Promise<EvidenceSource | null>` validates every resolved/redirected public destination, accepts bounded text/HTML, and returns the final URL and normalized text.
- `gatherWikipedia(input: ResearchInput, deps: WikiDeps): Promise<EvidenceSource[]>` follows the legacy state/subject matching approach.
- `reserveResearchCall(jobId: string, kind: 'web-search' | 'web-page' | 'model' | 'wiki-search' | 'wiki-article', deps: LimitDeps): Promise<'reserved' | 'exhausted'>` atomically reserves calls across retries/restarts; cached responses consume no external-request reservation.

- [ ] Write tests for Serper/Brave ordering, missing keys, capped quotas, provider errors, duplicate/redirected sources, snippets excluded from evidence, private-address redirects, oversized/unsupported responses, and deadline/budget exhaustion after resumption.
- [ ] Run `npx vitest run tests/research/retrieval.test.ts tests/research/fetch-page.test.ts tests/research/limits.test.ts`; confirm expected missing-implementation failures.
- [ ] Implement small adapters based on the inspected legacy modules. Keep runtime clients lazy and credentials server-side. Preserve the legacy page bounds: 1,500,000 response bytes and 6,000 extracted characters. Use durable usage/cache storage on Vercel rather than local JSON files. Preserve source text separately from the model-facing request.
- [ ] Invoke `mattpocock-skills:writing-for-agents` before writing tool descriptions. Define positive, ordered tool-use guidance; state the result and exhaustion conditions beside each capability.
- [ ] Verify the tests pass and commit. Fixture tests make no network requests.

## Task 3: Prove Eve integration can coexist with the application

**Files:** Modify `package.json`, lockfile, `next.config.ts`, `.gitignore`; create `agent/agent.ts`, `agent/channels/eve.ts`, `lib/server/research-context.ts`, `tests/research/runtime.test.ts`; document evidence in `docs/research.md`.

**Interfaces:** `createEveResearchSession(job: ResearchJob): Promise<{ sessionId: string; deliveryId: string }>` and `readEveResearchSession(receipt: { sessionId: string; deliveryId: string }): Promise<HostedResearchOutcome>` wrap version-matched Eve APIs; raw SDK types remain inside the adapter. `HostedResearchOutcome` is `pending`, a completed `ResearchResult`, or an explicit terminal failure. Use Task 1's job type with a controlled fixture context until Task 5 wires live dispatch.

- [ ] Read the installed-version Eve/AI SDK/Workflow docs before authoring SDK calls. Install a pinned Eve version with compatible peers in an isolated worktree; inspect the actual Node floor and `eve/next` implementation before changing the app's existing `withWorkflow` configuration.
- [ ] Add deterministic integration tests asserting trusted route auth is required, default shell/filesystem tools are unavailable, and the existing tagging/approval endpoints remain routed correctly. Run `npx vitest run tests/research/runtime.test.ts` and confirm intended failures.
- [ ] Implement the minimal runtime configuration and route policy. Protect session reads/controls as well as starts; Firebase authentication alone is insufficient without current membership and job/session ownership mapping. Keep the production agent unavailable until Task 5 supplies that mapping.
- [ ] Run the runtime test and `npm run build`. Verify both existing Workflow registration and Eve output are present. Run deterministic start/resume probes with a test model and persisted state; no paid model is needed for this compatibility check.
- [ ] Commit only after coexistence is proved. If it needs a deployment restructure, bring the concrete evidence and alternatives to Jonathan before proceeding.

## Task 4: Author and validate the research agent together

**Files:** Create `agent/instructions.md`, authored tools under `agent/tools/`, `lib/research/validate.ts`, `tests/research/{agent,validate}.test.ts`; update `agent/agent.ts` and `docs/research.md`.

**Interfaces:** `validateResearchResult(raw: unknown, sources: EvidenceSource[]): { draft: ResearchDraft; rejected: ResearchRejection[] }` resolves source IDs and screens shape, word limits, duplicates, and missing evidence. Tools use the Task 2 adapters with Task 3's controlled fixture context; Task 5 later supplies authenticated persisted run context.

- [ ] Invoke `mattpocock-skills:writing-for-agents` for this prompt-writing section. Walk through the instruction outline with Jonathan: exact identity, source gathering, claim selection, validation, and completion criteria. Put branch-specific guidance beside the branch it governs.
- [ ] Add deterministic cases for good sources, ambiguous/wrong subjects, empty evidence, unsupported claims, page text containing agent instructions, and limit exhaustion. Assertions require source IDs from fetched evidence, at most four facts, and explicit missing-evidence outcomes.
- [ ] Run `npx vitest run tests/research/agent.test.ts tests/research/validate.test.ts`; confirm failures for the missing prompt/tool contract or validator behavior.
- [ ] Write the prompt and tools. Use the legacy story style: one or two description sentences targeted at 45 words; facts at most 25 words. Keep grounded JSON/schema requirements and stop conditions checkable. Enforce call limits in the executor; any dynamic config I/O uses `ctx.memo`.
- [ ] Select an explicit live Gateway model with tool calling and structured results after inspecting the current catalog. Record model ID and configuration; ask for the paid pilot cap/authorization before a single real request. Prompt/schema changes after the pilot are recorded before freezing the benchmark candidate.
- [ ] Verify deterministic tests pass, then demonstrate one staged plate in local development against Gateway only after authorization and available credentials. This uses the controlled fixture mapping, with production endpoints still unavailable. Record factual review separately from plumbing success. Commit authored prompts and tool contracts.

## Task 5: Add durable research jobs and the desktop bridge

**Files:** Create `lib/research/{jobs,memory-store,firestore-store,tokens,hosted}.ts`, `workflows/research.ts`, research API routes from the file map, `worker/research-{main,run}.ts`, `tests/research/{jobs,routes,desktop,hosted}.test.ts`, `tests-emulator/research.test.ts`; update `lib/server/research-context.ts`.

**Interfaces:**
- Consume Task 1's `ResearchJob`, `ResearchResult`, and state types; this task owns the store transitions and trusted runtime mapping.
- `startResearch(deps, actor, { batchId, plateId, executor, requestKey, replaceJobId? }): Promise<Outcome<ResearchJob>>` captures the input and enforces idempotency, access, and pilot start authority.
- `claimResearch(deps, worker): Promise<ResearchClaim | null>`, `renewResearchClaim(deps, worker, { jobId, claimId }): Promise<Outcome<ResearchClaim>>`, and `reportResearch(deps, worker, { jobId, claimId, result }): Promise<Outcome<ResearchJob>>` fence desktop results.
- `acceptResearch(deps, actor, { jobId, baseRevision, fields }): Promise<Outcome<Plate>>` is implemented with Task 6's review-field support; an unready acceptance endpoint remains unavailable until then.

- [ ] Add lifecycle tests for duplicate starts, mismatched duplicate payloads, fixed executors, replacement fencing, expired/renewed/mismatched claims, removed users, cross-environment tokens, cross-user session access, stale plate input, and repeat reports. Replacements mark the older request superseded even when its work completes later.
- [ ] Run `npx vitest run tests/research/jobs.test.ts tests/research/routes.test.ts tests/research/desktop.test.ts tests/research/hosted.test.ts`; verify expected failures.
- [ ] Implement atomic store transitions, research-only tokens, outbound desktop claim/heartbeat/report, and an adapter calling Task 1's unchanged legacy pipeline. Follow the existing five-minute lease duration in `lib/server/context.ts` and renew before expiry during long local synthesis; the hosted five-minute deadline is independent.
- [ ] Persist Eve intent before session creation. Use the pinned SDK's idempotency/lookup mechanism to reconcile a crash between creation and receipt persistence; if it offers neither, fail visibly and require an explicit replacement rather than automatically starting another paid session. Store completion once; event replay cannot spend or accept twice. A model-call budget reservation survives replay.
- [ ] Keep reads durable across browser reload and Workflow restart. Completed stale output remains inspectable by authorized users but cannot be accepted. Expose unavailable desktop, errors, and partial/exhausted outcomes distinctly.
- [ ] Run focused unit tests, then `npm run test:emulator` after coordinating the emulator port with other local work. Record exactly which lifecycle/concurrency properties were verified. Commit the durable execution slice.

## Task 6: Review and accept research through existing Batch edits

**Files:** Modify `lib/catalog/types.ts`, `lib/review/{types,fields,batch,revision}.ts`, existing comparison components, plate-detail hooks/components; create `components/research/{research-actions,research-result}.tsx`, `lib/client/research.ts`, `tests/research/{accept,ui}.test.tsx`; extend existing review, catalog, publish and emulator tests.

**Interfaces:** Acceptable research fields are `description`, `funFacts`, `readMore`, and `wikiUrl`, using explicit types and the existing game-compatible optional shapes. Accepting a field resolves citations against the stored evidence registry. Task 5's `acceptResearch` calls the existing `proposeEdit` boundary with the current plate revision and current actor.

- [ ] Add tests proving facts-only and links-only acceptance preserves `sourceUrl`, existing unselected fields, and image metadata; absent draft fields cannot clear values. Reject unsupported URLs/source IDs and stale or superseded runs.
- [ ] Add tests proving each accepted research field changes the plate revision, invalidates prior approval, appears in the diff, and round-trips through the Snapshot serializer. Existing tolerant unknown-field handling alone is insufficient proof.
- [ ] Run `npx vitest run tests/research/accept.test.tsx tests/research/ui.test.tsx tests/review tests/catalog tests/publish`; verify intended failures before implementation.
- [ ] Extend every relevant allowlist/serialization layer together. Add per-run executor selection, durable progress, cited draft preview, and field-level accept/edit controls to the existing Plate screen. Persist valid accepted links and facts through the shared review edit operation.
- [ ] Verify tests and the affected live-Batch emulator scenarios. Inspect mobile and desktop behavior, including keyboard focus and clear offline/limit messages. Invoke the React review skill after edits to multiple TSX components.
- [ ] Commit the review flow. Run `npm run verify` and a production build before calling the integrated slice ready; publishing behavior is tested with mocked storage, not a real Publish.

## Task 7: Run the benchmark and try one Gateway search variant

**Files:** Extend `worker/research-benchmark.ts`; create `worker/research-report.ts`, `tests/research/benchmark.test.ts`; update `fixtures/research-eval.json` and `docs/research.md`.

**Interfaces:** `runResearchBenchmark(config: FrozenResearchBenchmark, deps: BenchmarkDeps): Promise<BenchmarkReport>` enforces the authorized global request/spend limits and records all four comparison modes from the design. `renderResearchReport(report: BenchmarkReport): string` produces a standalone local report with anonymous side-by-side outputs and claim-level evidence for scoring.

- [ ] Write tests for cached versus fresh sources, unavailable credentials, request/spend exhaustion across retries, failed plates retained in reliability results, missing-cost propagation, and blind output labels. An unscored run cannot report cost per accepted plate.
- [ ] Run `npx vitest run tests/research/benchmark.test.ts`; confirm failures identify the missing benchmark behavior.
- [ ] Implement baseline/candidate adapters and same-evidence synthesis control. Cache snapshots, identities, hashes, prompts, model/provider config, failures, raw outputs, and scoring decisions in ignored artifacts. Pin the corpus and model before measured calls and keep held-out plates out of tuning.
- [ ] Invoke `mattpocock-skills:writing-for-agents` before any judge prompt. Automated shape/overlap results remain screening; factual correctness and curator acceptance require claim/evidence review. Measure correction effort only from actual review activity, otherwise mark it unmeasured.
- [ ] After the initial existing-search comparison, inspect current Gateway search docs and add one experimental provider behind the same tool contract. Keep model, instruction content, and resource limits fixed where possible, recording unavoidable differences. Invoke `writing-for-agents` again if its tool description or prompt changes.
- [ ] Confirm credentials, model, final corpus, and the authorized remaining USD cap before real execution. Run bounded comparisons with staged outputs; stop when the cap is reached. Save partial reports instead of quietly increasing limits or shrinking the measured set.
- [ ] Review the blind results with Jonathan. Publish sanitized aggregate findings, uncertainty/sample size, and known/missing costs to #170; attach local artifact references in the local operating guide, not private paths on GitHub. Commit harness/report changes and complete final verification.

## Walkthrough checkpoints

1. Review this plan; begin with the evidence/result contract and capture baseline configuration.
2. Author the first instruction and tools together using `writing-for-agents`; inspect one staged run after the runtime compatibility check and paid authorization.
3. Review desktop/Eve switching, citations, and acceptance in the integrated application.
4. Freeze the benchmark configuration, run the comparison and search experiment, then review evidence and effectiveness.

## Self-review

The tasks cover both executors, explicit switching, bounded tools, evidence, authorization,
stale/replacement fencing, review-field round-trips, and all benchmark comparisons.
The five Review Focus cases each have named owner tasks and tests. Live model quality,
deployment compatibility, and paid-run readiness are separate checks; fixture tests do
not establish them. No implementation or paid execution has started from this plan.

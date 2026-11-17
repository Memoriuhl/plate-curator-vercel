# Plate research with Eve and AI Gateway

Status: approved by Jonathan on 2026-11-17. Tracking: [#170](https://github.com/Memoriuhl/plate-curator-vercel/issues/170).

## Intent and agreed choices

Jonathan wants to author an Eve agent together, integrate research into this application,
and benchmark its effectiveness against the current desktop pipeline. Research fills
descriptions, links, and fun facts about license plates and the subjects they represent.

Agreed in conversation:

- Desktop execution keeps the current local Ollama research pipeline.
- The Vercel implementation uses an Eve agent with AI Gateway.
- Start with the existing Wikipedia, Serper, and Brave search approach.
- Try Gateway-provided search tools later as a separate experiment.
- Finish with a comparison benchmark. The setup should remain understandable through a
  guided walkthrough of instructions, tools, configuration, execution, and results.

Jonathan approved the proposed design below. Model choice, the final benchmark corpus,
and authorization for paid runs remain the execution checkpoints described below.

## Prompt-authoring requirement

Before each section that authors or revises an agent-facing prompt, invoke
`mattpocock-skills:writing-for-agents`. Jonathan explicitly requested this for all
prompt-writing sections of this work. It applies to agent instructions, tool
descriptions, runtime research requests, repair/follow-up prompts, and benchmark-judge
prompts. Include it in the implementation plan and in any handoff that assigns one of
these sections; mark the skill invocation with that section's verification evidence.

## Approaches

We considered preserving existing search services while changing the agent/model, or
also replacing web search with Gateway-provided search. Jonathan chose the former to
start and wants to try the latter afterwards. Running the same Eve agent on desktop
and Vercel was also considered; Jonathan chose the existing Ollama pipeline locally
and Eve for Vercel instead.

## Proposed user flow

Start research for a plate in an editable Review Batch. Choose an execution option for
that run: Desktop / Ollama or Vercel / Eve. The choice is fixed on the accepted request;
changing a preference affects new requests only. An unavailable desktop leaves work
waiting with an explanation. Changing execution for existing work requires explicitly
starting a replacement run; neither path silently falls back to a paid model.

Both options produce a research draft with per-field sources. Reviewers can inspect,
accept, reject, or edit its description, facts, and links. Acceptance uses the existing
Batch revision and approval-invalidating edit path. It never publishes. Missing output
does not clear an existing value. Existing curator-reviewed text is not overwritten
without an explicit acceptance action.

The first integrated flow is one plate per request. A benchmark runner may process a
fixed list with bounded concurrency. A general bulk-research UI is outside this slice.
During the pilot, starting paid research is Owner-only; widening access is a later
product decision. Existing role and Batch access checks still govern review/acceptance.

## Agent behavior and outputs

Instructions tell Eve to identify the exact plate and jurisdiction, then research its
purpose, sponsorship, beneficiaries, origin, and useful subject history. It first uses
Wikipedia state-plate and subject material. If that material is missing, ambiguous, or
does not support the requested fields, it can search through the existing Serper/Brave
adapter and fetch relevant public pages. Prefer the issuing authority and official
sponsor for plate-specific eligibility, funding, and introduction claims. Subject
history may come from relevant Wikipedia or other attributable sources.

Search snippets locate pages; they are not evidence for a final claim. Record fetched
source text, final URL, title, fetch time, and content hash. Facts must cite source IDs
from the run's evidence registry. Return fewer facts, or no draft, when evidence is
insufficient. A page's instructions are source material, never agent instructions.

Initial outputs:

- A short description of the plate's purpose or origin, with source references.
- Zero to four short, distinct fun facts, each with a source reference.
- Read-more links resolved from fetched sources; a relevant Wikipedia link when found.
- Structured missing-evidence and rejection reasons for review and measurement.

Use the existing `funFacts` and `readMore` catalog shapes. Keep the evidence needed for
description citations in the research result even if it is not part of the Snapshot.
Do not repurpose `sourceUrl`, which can identify image provenance. First-issued year
is retained in baseline artifacts but is not an editable output in the first slice;
adding that field can follow once research quality is established.

Initial proposed limits per hosted plate: three web-search queries, six fetched web
pages, ten model calls, and a five-minute deadline. Wikipedia API calls are separately
bounded and cached. Limits include retries; partial output and exhaustion are recorded.
The executor enforces limits outside the prompt. A small pilot will check whether
these limits are useful before the benchmark configuration is frozen.

Use only authored research tools. Disable default shell, filesystem, and unrelated
search tools so the initial run uses the chosen adapters. Do not add subagents,
unattended schedules, publishing tools, or a general chat UI for this slice.

## Integration and execution

Add a distinct research-job contract rather than changing tagging's string-list
result. Capture the plate input, its revision, Batch baseline version, environment,
requester, executor, model/config versions, and request identity before dispatch.
Persist progress, evidence, terminal outcome, usage, and attempt errors. Retries reuse
the same request/session identity and cannot create a second accepted result.

The desktop bridge calls the legacy story implementation with the captured plate
identity and its existing Ollama configuration, returning staged results through
outbound authenticated calls. It must not apply local catalog edits or invoke
`saveCatalog`. A leased claim and claim identity fence late desktop reports. Record
the legacy code/model/prompt versions used; do not import the private legacy checkout
into the deployed Vercel bundle. Legacy comparison code remains unchanged.

The hosted adapter creates an Eve session and typed result, retaining the session ID
with the research job for durable reconciliation. Prefer integration beside the
existing Next.js app within the current Vercel project. Verify the documented
`eve/next` integration alongside this app's `withWorkflow` configuration before
adopting it; inspect the installed version's behavior and test build/resume compatibility.
If this requires a material deployment restructure, bring that decision back rather
than silently replacing existing deployment configuration.

Keep existing Firebase identity and live-membership checks. Only authorized requests
may start or read a run, inspect evidence, or accept a result. Agent endpoints must
not bypass the application's scope checks. Recheck access and plate revision when
accepting: a result for changed inputs remains inspectable but cannot overwrite newer
work. Tokens for the desktop bridge are scoped to research claims/results and the
environment; they cannot accept edits or publish.

Review currently allows description edits but not fun facts or links. Extend the
typed fields, validation, revision hashing, diffs, persistence, and Snapshot handling
together, with contract tests proving the new fields survive acceptance and publishing
without performing a real Publish. Preserve existing links when only another field
is accepted. Source fetching must retain the legacy public-URL/redirect safeguards,
response-size bounds, and timeouts.

AI Gateway uses deployment OIDC or an environment-held key. Search secrets stay on the
executing host. Keep credentials and raw benchmark/source artifacts out of Git. Verify
Node, Eve, and Workflow compatibility from the installed packages before setup.
Choose and record an explicit Gateway model after a small tool/structured-output
smoke test; no unapproved Astra model, implicit premium fallback, or unrecorded model
change is permitted.

## Benchmark

Before changing baseline behavior, freeze plate identities, input revisions, legacy
code/model/prompt configuration, source availability, and a scoring rubric. Propose
a 20-plate set covering straightforward material, sparse sources, ambiguous subjects,
and misleading organization/plate dates. Reserve part of it from prompt tuning.

Run these comparisons:

1. Current desktop/Ollama pipeline, unchanged, with existing retrieval.
2. Eve/AI Gateway with existing retrieval tools, on the same plate inputs.
3. A synthesis control using identical captured evidence where feasible, to distinguish
   writing quality from source discovery. Label this as a control, not a production path.
4. After the first conversion, try one Gateway search provider as a separate variant
   with the same Eve model, instructions, and budgets where possible.

Score source/subject relevance, support for every claim in its cited passage, useful
description/fact/link coverage, duplicate or generic text, incorrect dates and funding
claims, and acceptance/correction effort. Include a blind comparison of saved outputs.
Shape and lexical-grounding validators are screening checks, not the factual judge.

Report end-to-end latency, model/search calls, failures, known cost, missing cost, and
cost per accepted plate. Local hardware/energy cost is unmeasured unless separately
provided. Distinguish cold searches from cached ones. Preserve fetched text and raw
outputs so a later score can be audited. A source or credential failure is reported
explicitly and remains part of end-to-end reliability results.

Proposed total paid pilot/benchmark cap: USD 2, including search and model requests.
This is a proposed cap, not authorization to run paid requests. Freeze the final model,
limits, corpus, and spend cap before the measured runs. Do not claim effectiveness from
fixture tests or an unreviewed automatic score.

## Delivery and acceptance

Walk through the agent instructions and tool contracts first, then configure and run
one staged hosted plate. Add the durable job adapter, desktop bridge, and review/accept
flow after that behavior is understood. Capture baseline artifacts before tuning the
candidate. Run the frozen comparison and optional alternate-search experiment last.

Done means both chosen executors can research the agreed inputs, results and citations
survive reload, newer edits are protected, unavailable hosts and exhausted limits are
visible, and accepted fields survive the existing review/publish transformations in
tests. Attach implementation links and benchmark evidence to #170. Development and
benchmarking use staged outputs and staging services. Live catalog applies, publishing,
and bulk runs across all states require their own explicit authorization.

## Left to the implementation plan

Set exact module/route names, job-state transitions, claim renewal/cancellation details,
Eve completion reconciliation, artifact storage/retention, the minimum review controls,
and the selected model/search variant. Resolve these against the installed APIs and
existing application patterns. Scope changes, changed output fields, deployment
restructure, and increased paid limits return to Jonathan for a decision.

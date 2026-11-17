# Research comparison, 2026-11-17

These outputs were captured before the final code-review fixes to cost accounting, queue selection, and report contracts. No paid rerun was made after those fixes. This is an initial operational comparison, not evidence that the Eve output is more
factually accurate. The existing search keys were unavailable on both executing hosts.
The 20 inputs were frozen from staging Snapshot v16 before measured execution, with
six tuning plates and fourteen held-out plates. No prompts were tuned on the held-out
results. See `fixtures/research-eval-v16.json` for the identities and revisions.

| Path | Plates | Descriptions | Facts | Fetched links | Failed runs | Median | Known charges |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop / Ollama | 20 | 10 | 35 | 23 | 2 | 1.78s | Local hardware unmeasured |
| Eve / existing retrieval | 20 | 6 | 57 | 38 | 1 | 18.09s | $0.353690 |
| Gateway, identical desktop evidence | 20 | 5 | 40 | 18 | 0 | 5.20s | $0.070007 |
| Eve / Gateway Parallel | 20 | 3 | 22 | 17 | 13 | 23.84s | $0.630697 known, incomplete |

The desktop used unchanged legacy revision `b6f4ed51c0a17bd2aca03f33c21faac469673b35`,
`gemma4:12b`, and `story-v2`. Eve and the control used `openai/gpt-6.1-sol`.
The synthesis control skipped model calls for three source-empty plates, retaining
those cases in its denominator. Its latency percentiles include only the seventeen
measured calls; durations for those three skipped cases were not recorded. All other runs also remain in their denominators.
Pipeline status and lexical screening are not factual-quality scores.

Eve's standard path produced more facts and links but fewer plate descriptions, at
higher latency. The identical-source control did not improve description coverage.
This does not support replacing the desktop default on quality grounds yet. The
separate Parallel experiment was constrained by the ten-call and shared-budget
reservation limits, with failures retained. It remains experimental. Its provider tool
requires an additional bounded Sol invocation; these calls and known charges are
included. Search snippets still require a public-page fetch before citation.

Persistent source caches were used and exact cache attribution is unknown. The desktop's
first measured plate took 31.5s including model warmup; most later plates took 1–3s.
Latency is therefore not a cold-cache comparison. Local hardware and energy costs are
unmeasured. Accepted-plate count, correction effort, and cost per accepted plate remain
unmeasured until blind curator review.

The pilot cost $0.027363. The campaign's capped Gateway key reports **$1.0875386** total
spend, within the authorized **$2**. Summed artifacts are slightly lower because some
failed nested calls have missing reported cost. The shared ledger retains conservative
reservations ($1.301785 committed at completion) rather than assuming unknown calls
were free. The same key has a $1.80 lifetime cap and seven-day expiry. Local model calls
were disabled after the measured runs.

Raw requests/events, source passages, receipts, and model output remain in ignored local
`eval-results/research-*` directories. `npm run research:report` regenerates JSON, CSV,
Markdown, and `eval-results/research-report/blind-review.html`; its private key file
maps blind labels to executors. The blind review page exports a local JSON assessment
and sends nothing to a service. No catalog applies or real Publish occurred.

To finish the quality comparison: configure the existing search secrets, run a fresh
named comparison with a separately authorized remaining budget, and score source
support, relevance, duplicates, misleading dates/funding claims, acceptance, and actual
corrections through the blind review. Do not infer those scores from the table above.


Review follow-up: per-attempt cost settlement now retains unreported charges, desktop
claiming queries live desktop work without a first-100 cutoff, baseline/control/report
share per-plate artifacts, and reports retain unrun/interrupted manifest entries.
Regression tests cover all four fixes. Exact fresh/cached attribution remains a deferred
measurement improvement; the table does not imply a cold-cache comparison.
